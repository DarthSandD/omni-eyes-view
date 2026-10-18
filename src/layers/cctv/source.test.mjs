import test from 'node:test';
import assert from 'node:assert/strict';
import { createCctvSource, createCctvLayer } from './index.js';
import { resolveCctvApiBase } from './source.js';

const camera = {
  id: 'pack/camera ?x',
  name: 'Camera & road',
  city: 'Austin',
  lat: 30.267,
  lon: -97.744,
  headingDeg: 45,
  fovDeg: 60,
  pitchDeg: -12,
};

test('camera catalog and health use fixed source routes and caller cancellation', async () => {
  const calls = [];
  const source = createCctvSource({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return new Response(
        JSON.stringify(
          path.endsWith('/sources') ? { sources: [] } : { cameras: [] },
        ),
      );
    },
  });
  const controller = new AbortController();
  await source.getCatalog({ signal: controller.signal });
  await source.getHealth({ signal: controller.signal });
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/cctv/sources', '/api/cctv/health'],
  );
  for (const { options } of calls) {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, 'no-store');
  }
});

test('camera sources reject malformed snapshots and failures', async () => {
  for (const method of ['getCatalog', 'getHealth']) {
    const malformed = createCctvSource({
      fetchImpl: async () => new Response('{}'),
    });
    await assert.rejects(malformed[method](), /Malformed camera/);
    const denied = createCctvSource({
      fetchImpl: async () => new Response('', { status: 403 }),
    });
    await assert.rejects(denied[method](), /HTTP 403/);
  }
});

test('cancellation while reading a camera response body prevents publication', async () => {
  const controller = new AbortController();
  const source = createCctvSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { sources: [] };
      },
    }),
  });
  await assert.rejects(source.getCatalog({ signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('frame and media URLs preserve registered camera identity and encoded metadata', () => {
  const source = createCctvSource();
  const frame = new URL(source.getFrameUrl(camera), 'https://example.test');
  const media = new URL(source.getMediaUrl(camera), 'https://example.test');
  assert.equal(
    frame.pathname,
    '/api/cctv/frame/' + encodeURIComponent(camera.id),
  );
  assert.equal(
    media.pathname,
    '/api/cctv/media/' + encodeURIComponent(camera.id),
  );
  assert.equal(frame.searchParams.get('label'), camera.name);
  assert.equal(frame.searchParams.get('city'), camera.city);
  assert.equal(frame.searchParams.get('lat'), '30.267000');
  assert.equal(frame.searchParams.get('lon'), '-97.744000');
  assert.equal(frame.searchParams.get('heading'), '45');
  assert.equal(frame.searchParams.get('pitch'), '-12');
  assert.deepEqual([...media.searchParams.keys()], ['ts']);
});

test('camera construction is inert and destruction cancels a pending catalog and its visibility listener', async (t) => {
  const original = globalThis.document;
  const listeners = new Set();
  globalThis.document = {
    addEventListener(type, handler) {
      if (type === 'visibilitychange') listeners.add(handler);
    },
    removeEventListener(type, handler) {
      if (type === 'visibilitychange') listeners.delete(handler);
    },
  };
  t.after(() => {
    globalThis.document = original;
  });
  const noop = () => {};
  const services = {
    overlays: {
      clearOverlaySource: noop,
      hitTestWorldOverlay: noop,
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
    },
    sprites: { registerSpriteCollection: noop },
    activation: {},
    locations: {},
    picking: { unregisterPickOwner: noop },
    terrain: {},
    ground: {},
    mesh: {},
    focus: {},
    render: { releaseContinuousRender: noop },
  };
  let resolveCatalog;
  let signal;
  const source = {
    ...createCctvSource(),
    getCatalog(options) {
      signal = options.signal;
      return new Promise((resolve) => {
        resolveCatalog = resolve;
      });
    },
  };
  const a = createCctvLayer({ services, source });
  const b = createCctvLayer({ services, source });
  assert.equal(listeners.size, 0);
  const viewer = {
    scene: { primitives: { add: (value) => value, remove: () => true } },
  };
  const initializing = a.init(viewer);
  assert.equal(listeners.size, 1);
  assert.equal(signal.aborted, false);
  a.destroy(viewer);
  assert.equal(listeners.size, 0);
  assert.equal(signal.aborted, true);
  resolveCatalog({ sources: [] });
  await assert.rejects(initializing, { name: 'AbortError' });
  assert.equal(a.getStats().count, 0);
  assert.equal(b.getStats().count, 0);
});

test('frames are read through the registered frame endpoint', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const requested = [];
  const source = createCctvSource({
    fetchImpl: async (url, init) => {
      requested.push({ url, cache: init.cache });
      return new Response(png, {
        headers: { 'Content-Type': 'Image/PNG; charset=binary' },
      });
    },
  });
  const frame = await source.getFrame(camera);
  assert.equal(frame.contentType, 'image/png');
  assert.deepEqual([...frame.bytes], [...png]);
  assert.equal(
    requested[0].url.split('?')[0],
    '/api/cctv/frame/pack%2Fcamera%20%3Fx',
  );
  assert.equal(requested[0].cache, 'no-store');
  const failing = createCctvSource({
    fetchImpl: async () => new Response(null, { status: 502 }),
  });
  await assert.rejects(failing.getFrame(camera), /Camera frame HTTP 502/);
});

test('frame provenance admits the proxy kinds and leaves missing or unknown headers unknown', async () => {
  for (const kind of [
    'upstream-image',
    'hls-pull',
    'streetview',
    'synthetic',
    'other',
    null,
  ]) {
    const source = createCctvSource({
      fetchImpl: async () =>
        new Response(new Uint8Array([1]), {
          headers: {
            'Content-Type': 'image/png',
            ...(kind ? { 'X-CCTV-Source': kind } : {}),
          },
        }),
    });
    const frame = await source.getFrame(camera);
    assert.equal(frame.sourceKind, kind === 'other' ? null : kind);
  }
});

test('CCTV api base: github.io falls back to the worker, pages.dev and localhost stay same-origin', () => {
  assert.equal(
    resolveCctvApiBase({ hostname: 'darthsandd.github.io' }),
    'https://gev-api.darthsandd.workers.dev',
  );
  assert.equal(
    resolveCctvApiBase({ hostname: 'sub.darthsandd.github.io' }),
    'https://gev-api.darthsandd.workers.dev',
  );
  assert.equal(resolveCctvApiBase({ hostname: 'foo.pages.dev' }), '');
  assert.equal(resolveCctvApiBase({ hostname: 'localhost' }), '');
  assert.equal(resolveCctvApiBase({ hostname: '127.0.0.1' }), '');
  assert.equal(resolveCctvApiBase({ hostname: '' }), '');
});

test('CCTV api base precedence: ?api= > window.__GEV_API_BASE__ > build-time env > github.io', () => {
  assert.equal(
    resolveCctvApiBase({
      search: '?api=https://query.example/api/',
      hostname: 'darthsandd.github.io',
      globalApiBase: 'https://window.example',
      envApiBase: 'https://env.example',
    }),
    'https://query.example/api',
  );
  assert.equal(
    resolveCctvApiBase({
      hostname: 'darthsandd.github.io',
      globalApiBase: 'https://window.example/',
      envApiBase: 'https://env.example',
    }),
    'https://window.example',
  );
  assert.equal(
    resolveCctvApiBase({
      hostname: 'darthsandd.github.io',
      envApiBase: 'https://env.example',
    }),
    'https://env.example',
  );
  assert.equal(
    resolveCctvApiBase({
      apiBase: 'https://explicit.example',
      search: '?api=https://query.example',
      hostname: 'darthsandd.github.io',
    }),
    'https://explicit.example',
  );
});

test('CCTV fetches and frame/media URLs all carry the resolved api base', async () => {
  const calls = [];
  const source = createCctvSource({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ sources: [], cameras: [] }));
    },
    locationImpl: { search: '', hostname: 'darthsandd.github.io' },
    windowImpl: {},
  });
  assert.equal(
    source.apiBase,
    'https://gev-api.darthsandd.workers.dev',
  );
  await source.getCatalog();
  await source.getHealth();
  assert.ok(calls[0].startsWith('https://gev-api.darthsandd.workers.dev/api/cctv/sources'));
  assert.ok(calls[1].startsWith('https://gev-api.darthsandd.workers.dev/api/cctv/health'));
  assert.ok(
    source.getFrameUrl(camera).startsWith('https://gev-api.darthsandd.workers.dev/api/cctv/frame/'),
  );
  assert.ok(
    source.getMediaUrl(camera).startsWith('https://gev-api.darthsandd.workers.dev/api/cctv/media/'),
  );
  const sameOrigin = createCctvSource({
    locationImpl: { search: '', hostname: 'foo.pages.dev' },
    windowImpl: {},
  });
  assert.equal(sameOrigin.apiBase, '');
  assert.ok(sameOrigin.getFrameUrl(camera).startsWith('/api/cctv/frame/'));
});
