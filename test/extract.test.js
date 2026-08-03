import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectStreamUrls,
  extractTitle,
  findRedirect,
  sanitiseFilename,
} from '../src/extract.js';
import {
  formatVariantTable,
  isMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  selectVariant,
} from '../src/hls.js';

const BASE = 'https://voe.sx/e/abc123';

test('finds the JavaScript mirror redirect embed pages use', () => {
  assert.equal(
    findRedirect(`<script>window.location.href = 'https://mirror.example.net/e/x';</script>`, BASE),
    'https://mirror.example.net/e/x',
  );
  assert.equal(
    findRedirect(`<script>location.replace("/e/relocated")</script>`, BASE),
    'https://voe.sx/e/relocated',
  );
  assert.equal(findRedirect('<html>no redirect here</html>', BASE), null);
});

test('prefers og:title, falling back to <title> then the URL slug', () => {
  assert.equal(
    extractTitle('<meta property="og:title" content="My Video"><title>Ignored</title>', BASE),
    'My Video',
  );
  assert.equal(extractTitle('<title>Fallback &amp; Co</title>', BASE), 'Fallback & Co');
  assert.equal(extractTitle('<html></html>', BASE), 'abc123');
});

test('sanitiseFilename strips path separators, control chars and edge dots', () => {
  assert.equal(sanitiseFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitiseFilename('...hidden...'), 'hidden');
  assert.equal(sanitiseFilename('  spaced   out  '), 'spaced out');
  assert.equal(sanitiseFilename('///'), '___', 'separators become underscores, not nothing');
  // Only a name that sanitises away entirely falls back to the placeholder.
  assert.equal(sanitiseFilename(''), 'video');
  assert.equal(sanitiseFilename('   '), 'video');
  assert.equal(sanitiseFilename('...'), 'video');
  assert.equal(sanitiseFilename('x'.repeat(400)).length, 120);
});

test('ranks the HLS manifest above progressive and preview URLs', () => {
  const payload = {
    thumbnails: 'https://cdn.test/preview/thumbs.mp4',
    direct_access_url: 'https://cdn.test/progressive/video.mp4',
    source: 'https://cdn.test/hls/index.m3u8',
  };
  const ranked = collectStreamUrls(payload);
  assert.equal(ranked[0].url, 'https://cdn.test/hls/index.m3u8');
  // The preview track must never win, which is the flaw in a first-match walk.
  assert.notEqual(ranked[0].url, payload.thumbnails);
  assert.equal(ranked.at(-1).url, payload.thumbnails);
});

test('unwraps a URL hidden behind one more base64 layer', () => {
  const nested = Buffer.from('https://cdn.test/nested/index.m3u8').toString('base64');
  const ranked = collectStreamUrls({ source: nested });
  assert.equal(ranked[0].url, 'https://cdn.test/nested/index.m3u8');
});

test('ignores non-media strings in the payload', () => {
  assert.deepEqual(collectStreamUrls({ title: 'hi', site: 'https://voe.sx/faq' }), []);
});

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.64001e,mp4a.40.2"
480/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
https://other.cdn.test/720/index.m3u8
`;

test('parses a master playlist, best variant first, resolving relative URIs', () => {
  assert.ok(isMasterPlaylist(MASTER));
  const variants = parseMasterPlaylist(MASTER, 'https://cdn.test/v/master.m3u8');

  assert.equal(variants.length, 3);
  assert.equal(variants[0].height, 1080);
  assert.equal(variants[0].url, 'https://cdn.test/v/1080/index.m3u8');
  assert.equal(variants[1].url, 'https://other.cdn.test/720/index.m3u8');
  assert.equal(variants[0].codecs, 'avc1.640028,mp4a.40.2');
  assert.equal(variants[2].label, '480p');
});

test('quality selection: best, worst, exact and nearest-below', () => {
  const variants = parseMasterPlaylist(MASTER, 'https://cdn.test/v/master.m3u8');
  const pick = (q) => selectVariant(variants, q).height;

  assert.equal(pick(undefined), 1080);
  assert.equal(pick('best'), 1080);
  assert.equal(pick('worst'), 480);
  assert.equal(pick('720'), 720);
  assert.equal(pick('720p'), 720);
  assert.equal(pick(1000), 720, 'should step down to the next available height');
  assert.equal(pick(240), 480, 'should fall back to the smallest when all are taller');
  assert.equal(selectVariant([], 'best'), null);
});

test('formatVariantTable renders one row per variant', () => {
  const table = formatVariantTable(parseMasterPlaylist(MASTER, 'https://cdn.test/v/master.m3u8'));
  assert.equal(table.split('\n').length, 3);
  assert.match(table, /1080p\s+1920x1080\s+5\.00 Mbps/);
  assert.match(formatVariantTable([]), /single stream/);
});

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789ABCDEF0123456789ABCDEF
#EXTINF:9.009,
seg0.ts
#EXTINF:9.009,
seg1.ts
#EXTINF:3.500,
https://cdn.test/other/seg2.ts
#EXT-X-ENDLIST
`;

test('parses a media playlist with segments, durations and AES-128 key', () => {
  const { segments, totalDuration } = parseMediaPlaylist(MEDIA, 'https://cdn.test/v/480/index.m3u8');

  assert.equal(segments.length, 3);
  assert.equal(segments[0].url, 'https://cdn.test/v/480/seg0.ts');
  assert.equal(segments[2].url, 'https://cdn.test/other/seg2.ts');
  assert.equal(segments[2].index, 2);
  assert.ok(Math.abs(totalDuration - 21.518) < 0.001);

  assert.equal(segments[0].key.method, 'AES-128');
  assert.equal(segments[0].key.uri, 'https://cdn.test/v/480/key.bin');
  assert.equal(segments[0].key.iv, '0x0123456789ABCDEF0123456789ABCDEF');
});

test('an unencrypted playlist yields no key', () => {
  const plain = '#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n';
  const { segments } = parseMediaPlaylist(plain, 'https://cdn.test/p/index.m3u8');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].key, null);
  assert.ok(!isMasterPlaylist(plain));
});

test('EXT-X-MEDIA-SEQUENCE offsets the segment index used for the default IV', () => {
  const shifted = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:17\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n';
  const { segments } = parseMediaPlaylist(shifted, 'https://cdn.test/p/index.m3u8');
  assert.deepEqual(segments.map((s) => s.index), [17, 18]);
});
