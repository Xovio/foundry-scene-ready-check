export const MODULE_ID = "scene-ready";

const MAX_CONCURRENT = 6;
const SOUND_TIMEOUT = 15000;

/** The textures Foundry needs to draw a scene (mirrors TextureLoader.loadSceneTextures in v12). */
export function collectSources(scene) {
  const sources = new Set();
  const add = (src) => {
    // Wildcard token images are resolved when a token is placed and cannot be loaded as a file
    if (typeof src === "string" && src && !src.includes("*")) sources.add(src);
  };

  add(scene.background?.src);
  add(scene.foreground);
  add(scene.fog?.overlay);
  for (const tile of scene.tiles) add(tile.texture?.src);

  add(CONFIG.Token?.ring?.spritesheet);
  for (const token of scene.tokens) {
    add(token.texture?.src);
    if (token.ring?.enabled) add(token.ring.subject?.texture);
  }

  Object.values(CONFIG.controlIcons ?? {}).forEach(add);
  (CONFIG.statusEffects ?? []).forEach((effect) => add(effect.img ?? effect.icon));
  Object.values(globalThis.canvas?.sceneTextures ?? {}).forEach(add);
  return [...sources];
}

/** The sound Foundry would preload for a scene: its own sound, or the first track of its playlist. */
export function collectSound(scene) {
  if (scene.playlistSound?.path) return scene.playlistSound.path;
  const firstId = scene.playlist?.playbackOrder?.[0];
  return firstId ? scene.playlist.sounds.get(firstId)?.path ?? null : null;
}

/**
 * Loads all assets of a scene and reports every finished file.
 * Unlike Scenes#preload this exposes progress and failures.
 */
export async function preloadScene(scene, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const sources = collectSources(scene);
  const sound = collectSound(scene);
  const state = { loaded: 0, failed: 0, total: sources.length + (sound ? 1 : 0), failedFiles: [] };
  onProgress(state);

  const finish = (src, ok) => {
    if (ok) state.loaded++;
    else {
      state.failed++;
      state.failedFiles.push(src);
    }
    onProgress(state);
  };

  const loadTexture = async (src) => {
    if (isCancelled()) return;
    try {
      await TextureLoader.loader.loadTexture(src);
      finish(src, true);
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not load ${src}`, err);
      finish(src, false);
    }
  };

  const loadSound = async () => {
    if (isCancelled()) return;
    let timer;
    // Browsers can hold audio back until the user interacts, which must not block the check
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, SOUND_TIMEOUT); });
    try {
      await Promise.race([foundry.audio.AudioHelper.preloadSound(sound), timeout]);
      finish(sound, true);
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not load ${sound}`, err);
      finish(sound, false);
    } finally {
      clearTimeout(timer);
    }
  };

  const semaphore = new foundry.utils.Semaphore(MAX_CONCURRENT);
  const tasks = sources.map((src) => semaphore.add(loadTexture, src));
  if (sound) tasks.push(loadSound());
  await Promise.allSettled(tasks);
  return state;
}
