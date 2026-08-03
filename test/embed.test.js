import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeObfuscatedSrc,
  findEmbeddedUrl,
  findIframeSrc,
  isVoeHost,
  xorDecode,
} from '../src/embed.js';

const BASE = 'https://embed.example.com/1234/5678/abcdef/';
const TARGET = 'https://voe.sx/e/8y24ydxdztlc';

/**
 * The inverse of xorDecode. Tests build their own ciphertext rather than
 * shipping a captured page, exactly as the deobfuscate suite does.
 */
function encode(plain, key) {
  let raw = '';
  for (let i = 0; i < plain.length; i++) {
    raw += String.fromCharCode(plain.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return Buffer.from(raw, 'latin1').toString('base64');
}

/** A stand-in for the real wrapper: bare iframe, URL assembled in script. */
function embedPage(url, keyParts, { call } = {}) {
  const key = keyParts.join('');
  const names = keyParts.map((_, i) => `_k${i}`);
  const decls = keyParts.map((part, i) => `    var ${names[i]} = '${part}';`).join('\n');
  return `<!DOCTYPE html><html><body>
<iframe id="pl" frameborder="0" allowfullscreen></iframe>
<script>
(function () {
    var _e = '${encode(url, key)}';
${decls}
    function _xd(enc, k) { return atob(enc); }
    ${call ?? `var src = _xd(_e, ${names.join(' + ')});`}
    document.getElementById('pl').src = src;
})();
</script>
</body></html>`;
}

test('xorDecode round-trips, including a key shorter than the payload', () => {
  assert.equal(xorDecode(encode(TARGET, 'k'), 'k'), TARGET);
  assert.equal(xorDecode(encode(TARGET, '49880e9eb1b6d37e'), '49880e9eb1b6d37e'), TARGET);
  assert.equal(xorDecode('', 'key'), '');
  assert.equal(xorDecode('anything', ''), '', 'an empty key cannot decode anything');
});

test('xorDecode accepts base64url as well as standard base64', () => {
  const key = 'zz';
  const standard = encode(TARGET, key);
  const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(xorDecode(urlSafe, key), TARGET);
});

test('xorDecode survives bytes above 0x7f, which utf8 decoding would mangle', () => {
  // A key this dense pushes most of the ciphertext outside ASCII.
  const key = 'ðáÒ';
  assert.equal(xorDecode(encode(TARGET, key), key), TARGET);
});

test('findIframeSrc resolves absolute and relative sources, ignoring placeholders', () => {
  assert.equal(findIframeSrc(`<iframe src="${TARGET}"></iframe>`, BASE), TARGET);
  assert.equal(
    findIframeSrc('<iframe id="pl" scrolling="no" src="/player/9"></iframe>', BASE),
    'https://embed.example.com/player/9',
  );
  assert.equal(
    findIframeSrc(`<iframe src="https://x.test/a?b=1&amp;c=2"></iframe>`, BASE),
    'https://x.test/a?b=1&c=2',
    'entity-escaped query separators should be decoded',
  );
  assert.equal(
    findIframeSrc(`<iframe src="about:blank"></iframe><iframe src="${TARGET}"></iframe>`, BASE),
    TARGET,
    'a placeholder frame must not shadow the real one',
  );
  assert.equal(findIframeSrc('<iframe id="pl"></iframe>', BASE), null);
  assert.equal(findIframeSrc('<html>no frame at all</html>', BASE), null);
});

test('decodeObfuscatedSrc recovers the URL from a spliced key', () => {
  const html = embedPage(TARGET, ['49880', 'e9eb1b', '6d37e']);
  assert.deepEqual(decodeObfuscatedSrc(html), [TARGET]);
});

test('decodeObfuscatedSrc is not tied to the variable names', () => {
  const html = embedPage(TARGET, ['aa11', 'bb22'])
    .replace(/_e\b/g, 'qZ')
    .replace(/_xd\b/g, 'Q9');
  assert.deepEqual(decodeObfuscatedSrc(html), [TARGET]);
});

test('decodeObfuscatedSrc brute-forces a restructured decode call', () => {
  // No `f(payload, a + b + c)` to latch onto, so tier 1 finds nothing and the
  // fallback has to rebuild the key from consecutive literals.
  const html = embedPage(TARGET, ['49880', 'e9eb1b', '6d37e'], {
    call: 'var src = _xd.apply(null, [_e, [_k0, _k1, _k2].join("")]);',
  });
  assert.deepEqual(decodeObfuscatedSrc(html), [TARGET]);
});

test('decodeObfuscatedSrc puts a VOE host ahead of other decodable URLs', () => {
  const key = 'abcd';
  const html = `<script>
    var a = '${encode('https://ads.example.net/banner', key)}';
    var b = '${encode(TARGET, key)}';
    var k = '${key}';
    var x = dec(a, k); var y = dec(b, k);
  </script>`;
  assert.deepEqual(decodeObfuscatedSrc(html), [TARGET, 'https://ads.example.net/banner']);
});

test('decodeObfuscatedSrc yields nothing for a page with no hidden URL', () => {
  assert.deepEqual(decodeObfuscatedSrc('<html><body>hello</body></html>'), []);
  assert.deepEqual(
    decodeObfuscatedSrc(`<script>var msg = 'just some text'; var n = '42';</script>`),
    [],
  );
});

test('findEmbeddedUrl prefers a VOE host over an unrelated plain src', () => {
  const html = embedPage(TARGET, ['aa11', 'bb22']).replace(
    '<iframe id="pl"',
    '<iframe src="https://ads.example.net/banner"></iframe><iframe id="pl"',
  );
  assert.equal(findEmbeddedUrl(html, BASE), TARGET);
});

test('findEmbeddedUrl falls back to a plain src when nothing is obfuscated', () => {
  assert.equal(findEmbeddedUrl(`<iframe src="/player/9"></iframe>`, BASE), 'https://embed.example.com/player/9');
  assert.equal(findEmbeddedUrl('<html>nothing here</html>', BASE), null);
});

test('isVoeHost matches voe.sx and its mirrors but not lookalikes', () => {
  assert.ok(isVoeHost('voe.sx'));
  assert.ok(isVoeHost('n1.voe.sx'));
  assert.ok(isVoeHost('VOE.SX'));
  assert.ok(!isVoeHost('notvoe.com'));
  assert.ok(!isVoeHost('voessx.com'));
  assert.ok(!isVoeHost('embed.example.com'));
});
