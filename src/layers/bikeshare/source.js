/** Read a GBFS station document through the existing bounded server proxy. */
import { fetchWithProxyFallbackImpl } from '../../data/staticDirect.js';

export function createBikeshareSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getStations(upstreamUrl, { signal } = {}) {
      const url = new URL(upstreamUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash)
        throw new TypeError('A public HTTPS GBFS URL is required');
      signal?.throwIfAborted();
      // Static hosting: the /api/gbfs proxy 404s — fetch the feed directly.
      // Feeds without CORS headers fail per-feed and degrade (existing catch).
      const { response } = await fetchWithProxyFallbackImpl(
        fetchImpl,
        '/api/gbfs/' + encodeURIComponent(url.href),
        [url.href],
        { method: 'GET', headers: { Accept: 'application/json' }, signal },
      );
      if (!response.ok) throw new Error('GBFS HTTP ' + response.status);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!payload || typeof payload !== 'object')
        throw new Error('Malformed GBFS payload');
      return payload;
    },
  };
}
