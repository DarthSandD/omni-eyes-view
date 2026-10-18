import { DIRECTORY_ENDPOINT, RADIO_UUID_RE } from './policy.js';
import {
  RADIO_FALLBACK_MIRRORS,
  fetchRadioDirectoryDirect,
  isAbortError,
  isProxyMissing,
  proxyUrlWithBase,
} from '../../data/staticDirect.js';

/** Supply directory metadata and click reporting; audio stays with the broadcaster. */
export function createRadioSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getDirectory({ signal } = {}) {
      signal?.throwIfAborted();
      let body;
      let proxyStatus = null;
      try {
        const response = await fetchImpl(
          proxyUrlWithBase(DIRECTORY_ENDPOINT),
          { signal },
        );
        proxyStatus = response.status;
        if (!response.ok)
          throw new Error(`Radio directory returned ${response.status}`);
        body = await response.json();
      } catch (proxyError) {
        if (signal?.aborted) throw proxyError;
        if (isAbortError(proxyError)) throw proxyError;
        // A live broker's own refusal (rate limit, upstream 5xx) is respected
        // exactly as before — only an absent broker fails over to mirrors.
        if (proxyStatus !== null && !isProxyMissing({ status: proxyStatus }))
          throw proxyError;
        // Static hosting (GitHub Pages): the broker 404s — discover Radio
        // Browser mirrors client-side and query them directly. The direct body
        // is shaped like the broker response, so validation below holds.
        body = await fetchRadioDirectoryDirect({ signal });
      }
      signal?.throwIfAborted();
      return body;
    },
    async recordClick(id, { signal } = {}) {
      if (typeof id !== 'string' || !RADIO_UUID_RE.test(id))
        throw new Error('Invalid radio station id');
      signal?.throwIfAborted();
      const response = await fetchImpl(
        proxyUrlWithBase(`/api/radio/click/${encodeURIComponent(id)}`),
        {
          method: 'POST',
          signal,
        },
      );
      signal?.throwIfAborted();
      // Static hosting: no broker — count the click directly against a mirror (best-effort).
      fetch(
        `${RADIO_FALLBACK_MIRRORS[0]}/json/url/${encodeURIComponent(id)}`,
      ).catch(() => {});
      if (!response.ok)
        throw new Error(`Radio click returned ${response.status}`);
    },
  };
}
