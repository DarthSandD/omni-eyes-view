import {
  celestrakDirectUrl,
  fetchWithProxyFallbackImpl,
} from '../../data/staticDirect.js';

const GROUPS = new Set([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
]);

/** Read catalog text from the existing group endpoint using a supplied transport. */
export function createSatelliteSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async readGroup(group, { signal } = {}) {
      if (!GROUPS.has(group)) throw new TypeError('Unknown satellite group');
      signal?.throwIfAborted();
      // Static hosting: CelesTrak group direct (per-group degrade preserved;
      // bulk groups may 403/CORS-fail — degrade, retry, keep stale).
      const { response } = await fetchWithProxyFallbackImpl(
        fetchImpl,
        `/api/celestrak/${group}`,
        [celestrakDirectUrl(group)],
        { signal },
      );
      const text = response.ok ? await response.text() : '';
      signal?.throwIfAborted();
      // The proxy serves its last copy, marked STALE-ERROR, when CelesTrak
      // is down.
      const stale = response.headers?.get?.('x-tle-cache') === 'STALE-ERROR';
      return { ok: response.ok, status: response.status, text, stale };
    },
  };
}
