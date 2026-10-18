import {
  ACTIVE_FRAME_REFRESH_MS,
  FRAME_ENDPOINT,
  MEDIA_ENDPOINT,
} from './sourcePolicy.js';
const FRAME_SOURCE_KINDS = new Set([
  'upstream-image',
  'hls-pull',
  'streetview',
  'synthetic',
]);

/** Static-host fallback for the CCTV API: the deployed worker proxy. */
export const GITHUB_PAGES_CCTV_API_BASE =
  'https://gev-api.darthsandd.workers.dev';

/**
 * Resolves the base URL for CCTV API fetches.
 *
 * Precedence: explicit `apiBase` override > `?api=` query param >
 * `window.__GEV_API_BASE__` > build-time `import.meta.env.GEV_API_BASE` >
 * `*.github.io` host -> the deployed worker > '' (same-origin).
 * `*.pages.dev` and localhost stay same-origin: Cloudflare Pages proxies
 * `/api` itself and the dev server serves the API locally.
 *
 * @param {Object} [options]
 * @param {string} [options.apiBase] - Explicit caller override.
 * @param {string} [options.search] - `location.search` (e.g. `?api=https://…`).
 * @param {string} [options.hostname] - `location.hostname`.
 * @param {string} [options.globalApiBase] - `window.__GEV_API_BASE__`.
 * @param {string} [options.envApiBase] - Build-time `import.meta.env.GEV_API_BASE`.
 * @returns {string} Base URL without a trailing slash, or '' for same-origin.
 */
export function resolveCctvApiBase({
  apiBase,
  search = '',
  hostname = '',
  globalApiBase,
  envApiBase,
} = {}) {
  const clean = (value) =>
    typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  const explicit = clean(apiBase);
  if (explicit) return explicit;
  let queryApi = '';
  try {
    queryApi = clean(new URLSearchParams(search).get('api') || '');
  } catch {
    queryApi = '';
  }
  if (queryApi) return queryApi;
  const globalBase = clean(globalApiBase);
  if (globalBase) return globalBase;
  const envBase = clean(envApiBase);
  if (envBase) return envBase;
  const host = String(hostname || '')
    .trim()
    .toLowerCase();
  if (host.endsWith('github.io')) return GITHUB_PAGES_CCTV_API_BASE;
  return '';
}

function safeNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function frameUrlFor(
  camera,
  refreshMs = ACTIVE_FRAME_REFRESH_MS,
  apiBase = '',
) {
  const cadenceMs = Math.max(
    1000,
    safeNumber(refreshMs, ACTIVE_FRAME_REFRESH_MS),
  );
  const tick = Math.floor(Date.now() / cadenceMs);
  const params = new URLSearchParams({
    label: camera.name,
    city: camera.city,
    lat: camera.lat.toFixed(6),
    lon: camera.lon.toFixed(6),
    heading: String(Math.round(camera.headingDeg)),
    fov: String(Math.round(camera.fovDeg)),
    pitch: String(Math.round(camera.pitchDeg || -10)),
    ts: String(tick),
  });
  return `${apiBase}${FRAME_ENDPOINT}/${encodeURIComponent(camera.id)}?${params.toString()}`;
}
function mediaUrlFor(camera, apiBase = '') {
  return `${apiBase}${MEDIA_ENDPOINT}/${encodeURIComponent(camera.id)}?ts=${Math.floor(Date.now() / 15000)}`;
}
/** Supply catalog/health records and the existing registered camera URL families. */
export function createCctvSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiBase,
  locationImpl,
  windowImpl,
} = {}) {
  const location = locationImpl ?? globalThis.location;
  const win = windowImpl ?? globalThis.window;
  // Build-time base (Vite `define` in build/vite.js; undefined under plain Node).
  const envApiBase =
    typeof import.meta !== 'undefined' &&
    import.meta.env &&
    import.meta.env.GEV_API_BASE
      ? import.meta.env.GEV_API_BASE
      : '';
  const base = resolveCctvApiBase({
    apiBase,
    search: location?.search || '',
    hostname: location?.hostname || '',
    globalApiBase: win?.__GEV_API_BASE__,
    envApiBase,
  });
  async function read(path, key, { signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl(`${base}${path}`, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw new Error('Camera source HTTP ' + response.status);
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.[key]))
      throw new Error('Malformed camera ' + key + ' snapshot');
    return payload;
  }
  return {
    apiBase: base,
    getCatalog(options) {
      return read('/api/cctv/sources', 'sources', options);
    },
    getHealth(options) {
      return read('/api/cctv/health', 'cameras', options);
    },
    getFrameUrl: (camera, refreshMs) => frameUrlFor(camera, refreshMs, base),
    getMediaUrl: (camera) => mediaUrlFor(camera, base),
    /** Read a registered frame and its provenance, including fallback frames. */
    async getFrame(camera, { signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(frameUrlFor(camera, undefined, base), {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error('Camera frame HTTP ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      const type = response.headers.get('content-type') || '';
      const sourceKind = response.headers.get('x-cctv-source');
      return {
        contentType: type.split(';')[0].trim().toLowerCase(),
        bytes,
        sourceKind: FRAME_SOURCE_KINDS.has(sourceKind) ? sourceKind : null,
      };
    },
  };
}
