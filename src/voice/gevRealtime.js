import { toFunctionOutput } from '../tools/functions.js';
import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';
import { createGevActionRunner } from './gevActions.js';
import { createVoiceCommands } from './commands.js';
import { createRealtimeSession } from './realtimeSession.js';
import { cameraPoseKey, createPointerTracker } from './pointerContext.js';
import { createPointerPicker } from './pointerPick.js';
import { createReferentRegistry } from './referents.js';
import { resolveApiBase } from '../data/staticDirect.js';
import { createEmbeddedVoiceAgent } from './embeddedAgent.js';
import { getLocalSpeechRecognitionCtor } from './realtimeInputPolicy.js';
// Re-exported: localVoiceFallback + embeddedAgent tests import it from here.
export { getLocalSpeechRecognitionCtor };
export * from './realtimeController.js';

const ACTION_NAMES = new Set(GEV_ACTION_SCHEMAS.map((schema) => schema.name));

/**
 * Run app actions through `runner` and every other tool the catalog has
 * through the catalog. `loadCatalog` resolves the catalog when first needed.
 */
export function withToolCatalog(runner, loadCatalog) {
  if (typeof loadCatalog !== 'function') return runner;
  const runGevTool = async function runGevTool(name, args, options = {}) {
    if (ACTION_NAMES.has(name)) return runner(name, args, options);
    const catalog = await loadCatalog();
    if (!catalog?.get(name)) return runner(name, args, options);
    const result = await catalog.call(name, args ?? {}, {
      signal: options.signal,
    });
    return toFunctionOutput(name, result);
  };
  runGevTool.resetConversation = (...args) =>
    runner.resetConversation?.(...args);
  runGevTool.dispose = (...args) => runner.dispose?.(...args);
  return runGevTool;
}

/** Keyless voice fallback ctor lives in realtimeInputPolicy.js (re-exported above). */

/** Leading command verbs stripped so "fly to Austin" searches for Austin. */
const LOCAL_VOICE_LOCATION_PREFIX = /^(?:please\s+)?(?:fly(?:\s+me)?|go|navigate|zoom|take\s+me|bring\s+me|show\s+me|centre\s+on|center\s+on|look\s+at)\s+(?:to\b(?:\s+the\b)?|at\b(?:\s+the\b)?|towards?\b(?:\s+the\b)?|over\b(?:\s+the\b)?)?\s*/i;

/**
 * Route a free speech-recognition transcript into the existing gev action
 * runner. Location voice commands execute as `fly_to_location` searches (the
 * same runner + searchAndFlyTo path the Realtime model calls), so no backend
 * is needed. Returns null for empty transcripts. Exported for tests.
 * @param {string} transcript
 * @returns {{ action: string, args: { query: string } }|null}
 */
export function parseLocalVoiceCommand(transcript) {
  const text = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const query = text.replace(LOCAL_VOICE_LOCATION_PREFIX, '').trim() || text;
  return { action: 'fly_to_location', args: { query } };
}

/**
 * Base-relative public-asset URL (./mic.svg etc.) so icons resolve when the
 * app is served from a subpath such as GitHub Pages' /gods-eye-view/.
 * `import.meta.env` is a build-time define — plain node (unit tests) has no
 * `env` on it, so the read is guarded and falls back to './'.
 * Exported for tests.
 * @param {string} name
 * @returns {string}
 */
export function appAssetUrl(name) {
  let base = './';
  try {
    const envBase = import.meta.env.BASE_URL;
    if (typeof envBase === 'string' && envBase) base = envBase;
  } catch {
    base = './';
  }
  if (!base.endsWith('/')) base += '/';
  return `${base}${String(name || '').replace(/^\/+/, '')}`;
}

/**
 * Is there a worker API base + token route live for the OpenAI Realtime path?
 * When this is false the mic button is silent-degraded into the embedded agent
 * above, so start() must not surface VOICE SYSTEM ERROR.
 *
 * Fork semantics, kept deliberately: only an explicitly configured base
 * (`?api=<base>`, `window.__GEV_API_BASE__`, or build-time `GEV_API_BASE`)
 * counts as live. Same-origin `/api` is NOT treated as live — on static
 * hosting there is no token backend there, and the Realtime path costs real
 * money per minute, so it stays gated behind an explicit base.
 */
export function realtimeRouteLive() {
  const apiBase = resolveApiBase();
  if (!apiBase) return false;
  return true;
}

/**
 * Wrap the Realtime session adapter with the fork's mic-button policy:
 * prefer the free embedded (browser-native, zero-network) voice agent when
 * SpeechRecognition is supported; otherwise engage the OpenAI Realtime path
 * only when a worker API base + token route is live. The Realtime adapter
 * itself is untouched — this wrapper only owns start()/stop() routing, and
 * the embedded agent's transcripts run through the same gev action runner.
 * @param {object} hooks Session hooks from createVoiceSession (emit, runAction, …).
 * @param {object|null} sceneDirector Scene director for the agent's "play <scene>" matcher.
 * @returns {object} Session adapter with the Realtime adapter's full surface.
 */
function createEmbeddedFirstSession(hooks, sceneDirector) {
  const realtime = createRealtimeSession(hooks);
  let embedded = null;

  const stopEmbedded = () => {
    const agent = embedded;
    embedded = null;
    if (!agent || typeof agent.stop !== 'function') return;
    try {
      agent.stop();
    } catch {
      /* teardown must not throw */
    }
  };

  return {
    controller: realtime.controller,
    capabilities: realtime.capabilities,
    async start(settings) {
      if (embedded) return;
      // Prefer the free embedded path when it is supported. The OpenAI
      // Realtime path is only engaged when a worker API base + token route
      // is live; otherwise the mic button is silent-degraded to the embedded
      // agent (which is why no error tray fires below).
      const agent = createEmbeddedVoiceAgent({
        runner: (name, args, options) => hooks.runAction(name, args, options),
        // Scene titles feed the "play <scene>" matcher; the agent falls back
        // to static sceneNames when getSceneNames is absent.
        getSceneNames: sceneDirector?.listScenes?.bind(sceneDirector) || null,
        sceneNames: sceneDirector?.listScenes?.() || [],
        recognitionCtor: getLocalSpeechRecognitionCtor(),
        synthesis: undefined,
        geolocation: undefined,
        onStatus: (st) =>
          hooks.emit({ type: 'state', state: st.state, detail: st.detail }),
      });
      if (agent.isSupported()) {
        embedded = agent;
        if (agent.start({ continuous: true })) return;
        // start() failed (e.g. mic blocked): drop the agent and fall through
        // to the Realtime gate below instead of stranding the button.
        stopEmbedded();
      }
      // Embedded (browser-native, zero-network) voice is the free path and owns
      // the mic button / PTT when supported. Only engage the OpenAI Realtime path
      // when a worker API base + token route is actually live — otherwise the mic
      // button silent-degraded into the embedded agent above, so we must never
      // surface VOICE SYSTEM ERROR here while that path is available.
      if (!realtimeRouteLive()) {
        hooks.emit({
          type: 'state',
          state: 'idle',
          detail: 'Voice standby — no Realtime route',
        });
        return;
      }
      return realtime.start(settings);
    },
    stop(settings) {
      // Tear down the embedded (browser-native) voice agent so stop() is the
      // single teardown path for both voice transports — Realtime and embedded.
      stopEmbedded();
      return realtime.stop(settings);
    },
    sendText: (...args) => realtime.sendText(...args),
    sendMapEvent: (...args) => realtime.sendMapEvent(...args),
    ignoreButtonClick: (...args) => realtime.ignoreButtonClick?.(...args),
    bindControls: (...args) => realtime.bindControls?.(...args),
  };
}

/** Compose the standalone action runner with the voice controls. */
export function initGevVoiceCommands(options) {
  const canvas = options.viewer?.scene?.canvas || null;
  const cameraKey = () => cameraPoseKey(options.viewer);
  // Point-and-ask: the tracker and referents are shared by the runner (which
  // resolves 'pointer' and referent:n) and the controls (which snapshot the
  // pointer at turn start and clear both when the session ends).
  const pointer = canvas
    ? createPointerTracker({
        element: canvas,
        cameraKey,
        pick: createPointerPicker({
          viewer: options.viewer,
          dataManager: options.dataManager,
        }),
      })
    : null;
  const referents = createReferentRegistry();
  // The controller exists only after the runner, so its hooks bind late.
  const deixis = { pointer, referents, cameraKey };
  const sceneDirector =
    options.sceneDirector || options.dataManager?.sceneDirector || null;
  const commands = createVoiceCommands({
    ...options,
    pointer,
    referents,
    createSession: (hooks) => createEmbeddedFirstSession(hooks, sceneDirector),
    runner: withToolCatalog(
      createGevActionRunner({ ...options, deixis }),
      options.toolCatalog,
    ),
  });
  deixis.imageFrame = () => commands.retainedImageFrame?.() || null;
  deixis.onPointerUsed = () => commands.announcePointer?.();
  commands.session?.signal?.addEventListener(
    'abort',
    () => pointer?.destroy(),
    { once: true },
  );
  return commands;
}
