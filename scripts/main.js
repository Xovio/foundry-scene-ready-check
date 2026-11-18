import { MODULE_ID, preloadScene } from "./preload.js";
import { initI18n, t } from "./i18n.js";

const SOCKET = `module.${MODULE_ID}`;
const REPORT_INTERVAL = 250;
const TICK_INTERVAL = 2000;
const STALLED_AFTER = 15000;
const MAX_REPORTED_FAILURES = 20;

// foundry.utils.escapeHTML only exists from v13 on
const escapeHTML = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* ------------------------------------------------------------------ Setup */

Hooks.once("init", () => {
  initI18n(MODULE_ID);
  game.settings.register(MODULE_ID, "autoActivate", {
    scope: "client", config: false, type: Boolean, default: false
  });
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onMessage);
  game.modules.get(MODULE_ID).api = { prepare: (scene) => SceneReadyApp.open(scene) };
});

function onMessage(message) {
  switch (message.action) {
    case "prepare":
      if (!message.targets || message.targets.includes(game.user.id)) runLocal(message);
      break;
    case "cancel":
      cancelLocal(message.runId);
      break;
    case "progress":
      SceneReadyApp.instance?.receive(message);
      break;
  }
}

/* ------------------------------------------------------------------ Loading on this client */

let localRun = null;

function send(message) {
  game.socket.emit(SOCKET, message);
  SceneReadyApp.instance?.receive(message);
}

const showBar = (pct) => SceneNavigation.displayProgressBar({ label: t("player.loading"), pct });

function cancelLocal(runId) {
  if (!localRun || localRun.runId !== runId || localRun.cancelled) return;
  localRun.cancelled = true;
  if (!localRun.last?.done) showBar(100);
}

async function runLocal({ runId, sceneId }) {
  // The GM repeats the request until it hears back, so answer repeats with the latest state
  if (localRun?.runId === runId) {
    if (localRun.last) send(localRun.last);
    return;
  }
  if (localRun) cancelLocal(localRun.runId);
  const run = localRun = { runId, cancelled: false, last: null };

  const publish = (data) => {
    run.last = { action: "progress", runId, userId: game.user.id, ...data };
    send(run.last);
  };

  const scene = game.scenes.get(sceneId);
  if (!scene) return publish({ loaded: 0, failed: 0, total: 0, done: true, missing: true });
  if (game.settings.get("core", "noCanvas")) return publish({ loaded: 0, failed: 0, total: 0, done: true, noCanvas: true });

  let lastSent = 0;
  const snapshot = (state, done) => ({
    loaded: state.loaded,
    failed: state.failed,
    total: state.total,
    done,
    failedFiles: state.failedFiles.slice(0, MAX_REPORTED_FAILURES)
  });

  const state = await preloadScene(scene, {
    isCancelled: () => run.cancelled,
    onProgress: (current) => {
      if (run.cancelled) return;
      const finished = current.loaded + current.failed;
      showBar(current.total ? Math.min(99, Math.floor((finished / current.total) * 100)) : 99);
      const now = Date.now();
      if (now - lastSent < REPORT_INTERVAL) return;
      lastSent = now;
      publish(snapshot(current, false));
    }
  });

  if (run.cancelled) return;
  showBar(100);
  publish(snapshot(state, true));
}

/* ------------------------------------------------------------------ GM window */

class SceneReadyApp extends Application {
  static instance = null;

  static async open(scene) {
    if (!game.user.isGM || !scene) return null;
    await this.instance?.close();
    const app = new SceneReadyApp(scene);
    this.instance = app;
    app.render(true);
    app.start();
    return app;
  }

  constructor(scene, options) {
    super(options);
    this.sceneId = scene.id;
    this.runId = foundry.utils.randomID();
    this.reports = new Map();
    this.startedAt = Date.now();
    this.activated = false;
    this.timer = null;
    this.renderTimer = null;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "scene-ready",
      width: 400,
      height: "auto",
      resizable: false,
      classes: ["scene-ready-app"]
    });
  }

  get title() {
    return `${t("title")}: ${this.scene?.name ?? ""}`;
  }

  get scene() {
    return game.scenes.get(this.sceneId);
  }

  get activeUsers() {
    return game.users.filter((user) => user.active);
  }

  get allReady() {
    const users = this.activeUsers;
    return users.length > 0 && users.every((user) => this.reports.get(user.id)?.done);
  }

  start() {
    const message = { action: "prepare", runId: this.runId, sceneId: this.sceneId };
    game.socket.emit(SOCKET, message);
    runLocal(message);
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL);
  }

  /** Repeats the request for clients that have not answered yet, e.g. players who just joined. */
  tick() {
    const targets = this.activeUsers.filter((user) => !user.isSelf && !this.reports.has(user.id)).map((user) => user.id);
    if (targets.length) game.socket.emit(SOCKET, { action: "prepare", runId: this.runId, sceneId: this.sceneId, targets });
    this.renderSoon();
  }

  receive(report) {
    if (report.runId !== this.runId) return;
    this.reports.set(report.userId, { ...report, at: Date.now() });
    this.renderSoon();
    this.activateIfWanted();
  }

  userChanged(user, connected) {
    // A returning player starts from scratch after the reload
    if (connected) this.reports.delete(user.id);
    this.renderSoon();
    this.activateIfWanted();
  }

  activateIfWanted() {
    if (this.activated || !this.allReady) return;
    if (game.settings.get(MODULE_ID, "autoActivate")) this.activate();
  }

  async activate() {
    if (this.activated) return;
    const scene = this.scene;
    if (!scene) return;
    this.activated = true;
    try {
      await scene.activate();
      await this.close({ keepLoading: true });
    } catch (err) {
      this.activated = false;
      ui.notifications.error(err.message);
    }
  }

  renderSoon() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      if (this.rendered) this.render();
    }, 150);
  }

  statusOf(user) {
    const report = this.reports.get(user.id);
    if (!user.active) return "offline";
    if (!report) return Date.now() - this.startedAt > STALLED_AFTER ? "stalled" : "waiting";
    if (report.missing) return "missing";
    if (report.noCanvas) return "noCanvas";
    if (report.done) return report.failed ? "problems" : "ready";
    return Date.now() - report.at > STALLED_AFTER ? "stalled" : "loading";
  }

  async _renderInner() {
    const users = game.users.filter((user) => user.active || this.reports.has(user.id));
    const active = this.activeUsers;
    const readyCount = active.filter((user) => this.reports.get(user.id)?.done).length;
    const allReady = this.allReady;
    const auto = game.settings.get(MODULE_ID, "autoActivate");

    const rows = users.map((user) => {
      const report = this.reports.get(user.id);
      const status = this.statusOf(user);
      const finished = (report?.loaded ?? 0) + (report?.failed ?? 0);
      const total = report?.total ?? 0;
      const pct = report?.done ? 100 : total ? Math.floor((finished / total) * 100) : 0;
      return `
        <li class="sr-row sr-${status}">
          <span class="sr-dot" style="background:${escapeHTML(user.color?.css ?? user.color)}"></span>
          <span class="sr-name">${escapeHTML(user.name)}</span>
          <span class="sr-count">${total ? `${finished}/${total}` : ""}</span>
          <span class="sr-status">${t(`status.${status}`)}</span>
          <span class="sr-bar"><span style="width:${pct}%"></span></span>
        </li>`;
    }).join("");

    const failedFiles = [...new Set([...this.reports.values()].flatMap((report) => report.failedFiles ?? []))];
    const failures = failedFiles.length ? `
      <section class="sr-failures">
        <h4><i class="fas fa-triangle-exclamation"></i> ${t("failedFiles")}</h4>
        <ul>${failedFiles.map((file) => `<li title="${escapeHTML(file)}">${escapeHTML(file)}</li>`).join("")}</ul>
      </section>` : "";

    return $(`
      <div class="sr">
        <p class="sr-summary ${allReady ? "is-ready" : ""}">
          <i class="fas ${allReady ? "fa-circle-check" : "fa-spinner fa-spin"}"></i>
          ${allReady ? t("allReady") : t("summary", { ready: readyCount, total: active.length })}
        </p>
        <ul class="sr-list">${rows}</ul>
        ${failures}
        <label class="sr-auto"><input type="checkbox" name="autoActivate" ${auto ? "checked" : ""}> ${t("autoActivate")}</label>
        <button type="button" class="sr-activate ${allReady ? "is-ready" : ""}" data-action="activate">
          <i class="fas fa-play"></i> ${allReady ? t("activate") : t("activateAnyway")}
        </button>
      </div>`);
  }

  activateListeners(html) {
    super.activateListeners(html);
    const root = html[0];
    root.querySelector("[data-action=activate]")?.addEventListener("click", () => this.activate());
    root.querySelector("input[name=autoActivate]")?.addEventListener("change", async (event) => {
      await game.settings.set(MODULE_ID, "autoActivate", event.target.checked);
      this.activateIfWanted();
    });
  }

  async close(options = {}) {
    clearInterval(this.timer);
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
    // After activating, loading continues because it still helps the scene that is opening
    if (!options.keepLoading && !this.allReady) {
      game.socket.emit(SOCKET, { action: "cancel", runId: this.runId });
      cancelLocal(this.runId);
    }
    if (SceneReadyApp.instance === this) SceneReadyApp.instance = null;
    return super.close(options);
  }
}

/* ------------------------------------------------------------------ Entry points */

function menuEntry(sceneOf) {
  return {
    name: t("menu.prepare"),
    icon: '<i class="fas fa-hourglass-half"></i>',
    condition: (li) => {
      const scene = sceneOf(li);
      return game.user.isGM && !!scene && !scene.active;
    },
    callback: (li) => SceneReadyApp.open(sceneOf(li))
  };
}

Hooks.on("getSceneNavigationContext", (html, options) => {
  options.push(menuEntry((li) => game.scenes.get(li.attr("data-scene-id"))));
});

Hooks.on("getSceneDirectoryEntryContext", (html, options) => {
  options.push(menuEntry((li) => game.scenes.get(li.attr("data-document-id"))));
});

Hooks.on("userConnected", (user, connected) => SceneReadyApp.instance?.userChanged(user, connected));

Hooks.on("deleteScene", (scene) => {
  const app = SceneReadyApp.instance;
  if (app?.sceneId !== scene.id) return;
  ui.notifications.warn(t("sceneGone"));
  app.close();
});
