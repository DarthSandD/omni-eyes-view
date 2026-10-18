// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
import {
  celestrakDirectUrl,
  fetchWithProxyFallbackImpl,
  launchLibraryDirectUrl,
} from '../../data/staticDirect.js';

const msg = (text) => text;

/** Read launch records and their optional active-orbit catalog with explicit cancellation. */
export function createLaunchSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /** The launch payload, and whether the proxy served it from a stale cache. */
  async function getLaunchSnapshot({ signal } = {}) {
    signal?.throwIfAborted();
    // Static hosting: Launch Library 2 is keyless — fetch direct on proxy 404.
    const { response } = await fetchWithProxyFallbackImpl(
      fetchImpl,
      '/api/launches',
      [launchLibraryDirectUrl(30, 100)],
      { signal },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!Array.isArray(payload) && !Array.isArray(payload?.results))
      throw new Error(msg('Malformed launch snapshot'));
    return {
      payload,
      stale: response.headers?.get?.('x-gev-cache') === 'STALE-ERROR',
    };
  }
  return {
    getLaunchSnapshot,
    async getLaunches(options) {
      return (await getLaunchSnapshot(options)).payload;
    },
    async getActiveTle({ signal } = {}) {
      signal?.throwIfAborted();
      // Static hosting: the bulk `active` group may 403/CORS-fail direct — the
      // existing degrade path (null TLE text, mission update still renders) holds.
      const { response } = await fetchWithProxyFallbackImpl(
        fetchImpl,
        '/api/celestrak/active',
        [celestrakDirectUrl('active')],
        { signal },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      signal?.throwIfAborted();
      return text;
    },
  };
}
