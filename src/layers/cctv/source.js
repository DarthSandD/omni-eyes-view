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

function safeNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Whether a CCTV API failure is worth one retry.
 * Static-host misses (404/405/501, no /api route) plus transient upstream
 * failures (502/503/504, degraded worker) — everything else surfaces as-is.
 * @param {number} status - HTTP response status.
 * @returns {boolean} True when the request should be retried once.
 */
export function shouldRetryCctvWorker(status) {
  return (
    status === 404 ||
    status === 405 ||
    status === 501 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/**
 * Resolve the API base for CCTV /api calls.
 * Mirrors `resolveApiBase` in src/data/staticDirect.js (same precedence:
 * `?api=<base>` boot override > `window.__GEV_API_BASE__` >
 * `import.meta.env.GEV_API_BASE` > '' same-origin). It is inlined here
 * rather than imported because this module is a portable source root:
 * the import-direction check forbids it from reaching browser globals, and
 * staticDirect.js references `window`. `globalThis.__GEV_API_BASE__` reads
 * the same property (`window` IS the global object in browsers) without
 * naming the `window` identifier.
 * @returns {string} Normalized base, or '' for same-origin.
 */
function resolveCctvApiBase() {
  try {
    const search = globalThis.location?.search;
    if (typeof search === 'string' && search) {
      const boot = new URLSearchParams(search).get('api');
      if (typeof boot === 'string' && boot.trim()) {
        return boot.trim().replace(/\/+$/, '');
      }
    }
  } catch {
    /* no location — fall through */
  }
  try {
    const runtime = globalThis.__GEV_API_BASE__;
    if (typeof runtime === 'string' && runtime.trim()) {
      return runtime.trim().replace(/\/+$/, '');
    }
  } catch {
    /* no runtime override — fall through */
  }
  try {
    if (
      typeof import.meta.env?.GEV_API_BASE === 'string' &&
      import.meta.env.GEV_API_BASE.trim()
    ) {
      return import.meta.env.GEV_API_BASE.trim().replace(/\/+$/, '');
    }
  } catch {
    /* plain Node: no import.meta.env — fall through */
  }
  return '';
}

/**
 * Prefix a same-origin `/api/*` path with the configured API base (the
 * GEV_API_BASE worker origin on static hosts such as github.io).
 * Absolute/direct upstream URLs pass through untouched.
 * @param {string} proxyUrl - Same-origin /api/* URL.
 * @returns {string} Base-prefixed URL, or the input unchanged.
 */
export function cctvProxyUrlWithBase(proxyUrl) {
  if (typeof proxyUrl !== 'string' || !/^\/api(?=\/|$|\?)/.test(proxyUrl)) {
    return proxyUrl;
  }
  const base = resolveCctvApiBase();
  if (!base) return proxyUrl;
  return `${base}${proxyUrl}`;
}

function frameUrlFor(camera, refreshMs = ACTIVE_FRAME_REFRESH_MS) {
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
  return cctvProxyUrlWithBase(
    `${FRAME_ENDPOINT}/${encodeURIComponent(camera.id)}?${params.toString()}`,
  );
}
function mediaUrlFor(camera) {
  return cctvProxyUrlWithBase(
    `${MEDIA_ENDPOINT}/${encodeURIComponent(camera.id)}?ts=${Math.floor(Date.now() / 15000)}`,
  );
}
/** Supply catalog/health records and the existing registered camera URL families. */
export function createCctvSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  let lastFetchMeta = null;

  /**
   * Fetch once, retrying a single time on a retryable HTTP status
   * (see shouldRetryCctvWorker) or a network failure. Aborts never retry.
   * Records the outcome for provenance (see getLastFetchMeta).
   */
  async function fetchWithOneRetry(url, init, { signal } = {}) {
    signal?.throwIfAborted();
    let retried = false;
    let response;
    try {
      try {
        response = await fetchImpl(url, init);
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        // Network failure: one retry against the same URL.
        retried = true;
        signal?.throwIfAborted();
        response = await fetchImpl(url, init);
      }
      if (!response.ok && shouldRetryCctvWorker(response.status)) {
        signal?.throwIfAborted();
        retried = true;
        response = await fetchImpl(url, init);
      }
    } catch (error) {
      lastFetchMeta = { status: null, ok: false, retried };
      throw error;
    }
    lastFetchMeta = {
      status: response.status,
      ok: response.ok,
      retried,
    };
    return response;
  }

  async function read(path, key, { signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchWithOneRetry(
      cctvProxyUrlWithBase(path),
      { cache: 'no-store', signal },
      { signal },
    );
    if (!response.ok) throw new Error('Camera source HTTP ' + response.status);
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.[key]))
      throw new Error('Malformed camera ' + key + ' snapshot');
    return payload;
  }
  return {
    getCatalog(options) {
      return read('/api/cctv/sources', 'sources', options);
    },
    getHealth(options) {
      return read('/api/cctv/health', 'cameras', options);
    },
    getFrameUrl: frameUrlFor,
    getMediaUrl: mediaUrlFor,
    /**
     * Outcome of the most recent catalog/health/frame fetch:
     * `{ status, ok, retried }`, or null before any fetch. The catalog
     * layer reads this to mark provenance honestly (live vs seed fallback,
     * retried vs first-try) instead of claiming live on seed data.
     */
    getLastFetchMeta() {
      return lastFetchMeta ? { ...lastFetchMeta } : null;
    },
    /** Read a registered frame and its provenance, including fallback frames. */
    async getFrame(camera, { signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchWithOneRetry(
        cctvProxyUrlWithBase(frameUrlFor(camera)),
        { cache: 'no-store', signal },
        { signal },
      );
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
