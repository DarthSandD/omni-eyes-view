import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadIndonesiaSourcesFromCatalog } from './sources.js';
import { normalizeSourceItem } from './normalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');

const EXPECTED_IDS = [
  'jt-km04600',
  'jt-km10600',
  'jt-km13600',
  'jt-km15500',
  'jakarta-senayan-toll',
  'serang-walantaka-toll',
  'bandung-gedung-sate',
  'bandung-alun-alun',
  'semarang-simpang-lima',
  'semarang-lawang-sewu',
  'surabaya-tunjungan',
  'surabaya-balai-kota',
];

test('Indonesia loader serves all 12 curated rows with pageUrl portals', () => {
  const rows = loadIndonesiaSourcesFromCatalog({ sourceRoot: ROOT });
  assert.equal(rows.length, 12);
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    [...EXPECTED_IDS].sort(),
  );
  for (const row of rows) {
    assert.ok(
      typeof row.pageUrl === 'string' && row.pageUrl.startsWith('https://'),
      `${row.id} needs a pageUrl portal`,
    );
    assert.ok(
      ['jakarta', 'serang', 'bandung', 'semarang', 'surabaya'].includes(
        row.cityId,
      ),
    );
  }
  // Rows with coordinates keep them; portal-only seeds keep NaN (the client
  // seed catalog supplies their positions by id).
  const withCoords = rows.filter(
    (row) => Number.isFinite(row.lat) && Number.isFinite(row.lon),
  );
  assert.equal(withCoords.length, 6);
  // Feed URLs stay on the pack's own origins.
  for (const row of rows.filter((row) => row.url)) {
    assert.match(
      row.url,
      /^https:\/\/(jmlive\.jasamarga\.com|cctv\.wikaserangpanimbang\.com|atcs-dishub\.bandung\.go\.id(?::\d+)?|livepantau\.semarangkota\.go\.id)\//,
    );
  }
});

test('normalizeSourceItem passes pageUrl through to the client', () => {
  const normalized = normalizeSourceItem({
    id: 'serang-walantaka-toll',
    name: 'Walantaka Toll Gate',
    city: 'Serang',
    cityId: 'serang',
    feedType: 'hls',
    url: 'https://cctv.wikaserangpanimbang.com/camera/bearer/tiod/1/1/index.m3u8',
    pageUrl:
      'https://binamarga.pu.go.id/contents/cctv_tol/?id_ruas=serang-panimbang-seksi-1-serang-rangkasbitung',
  });
  assert.equal(
    normalized.pageUrl,
    'https://binamarga.pu.go.id/contents/cctv_tol/?id_ruas=serang-panimbang-seksi-1-serang-rangkasbitung',
  );
  assert.equal(normalizeSourceItem({ id: 'x' }).pageUrl, undefined);
});
