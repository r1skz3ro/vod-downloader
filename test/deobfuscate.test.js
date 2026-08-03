import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DeobfuscationError,
  JUNK_PATTERNS,
  SHIFT,
  deobfuscate,
  deobfuscateWithTrace,
  extractPayloadString,
  reverseString,
  rot13,
  shiftCharCodes,
  stripJunk,
} from '../src/deobfuscate.js';

/**
 * The inverse of the pipeline in src/deobfuscate.js. Having it here lets every
 * test build its own payload, so the suite runs offline and ships no captured
 * page content.
 *
 * @param {unknown} value           the object to hide
 * @param {number} junkEvery        insert a junk digraph every N characters (0 = none)
 */
function obfuscate(value, junkEvery = 7) {
  const toBase64 = (binary) => Buffer.from(binary, 'latin1').toString('base64');

  let step = toBase64(Buffer.from(JSON.stringify(value), 'utf8').toString('latin1'));
  step = reverseString(step);
  step = shiftCharCodes(step, -SHIFT); // the encoder adds what the decoder subtracts
  step = toBase64(step);

  if (junkEvery > 0) {
    let junked = '';
    for (let i = 0; i < step.length; i++) {
      junked += step[i];
      if (i % junkEvery === junkEvery - 1) {
        junked += JUNK_PATTERNS[i % JUNK_PATTERNS.length];
      }
    }
    step = junked;
  }

  return JSON.stringify([rot13(step)]);
}

test('round-trips an object through the full pipeline', () => {
  const original = {
    source: 'https://delivery-node-01.example.net/engine/hls2/01/00042/index-v1-a1.m3u8?t=abc&s=123',
    direct_access_url: 'https://example.net/progressive/00042.mp4',
    title: 'Episode 1',
    duration: 1421.5,
  };
  assert.deepEqual(deobfuscate(obfuscate(original)), original);
});

test('accepts a bare payload string as well as the ["…"] literal', () => {
  const original = { source: 'https://cdn.example.net/a/index.m3u8' };
  const literal = obfuscate(original);
  const bare = JSON.parse(literal)[0];

  assert.deepEqual(deobfuscate(literal), original);
  assert.deepEqual(deobfuscate(bare), original);
});

test('rot13 is its own inverse and leaves the junk digraphs untouched', () => {
  assert.equal(rot13(rot13('Hello, World! 123')), 'Hello, World! 123');
  // This is why steps 1 and 2 of the pipeline commute.
  for (const pattern of JUNK_PATTERNS) {
    assert.equal(rot13(pattern), pattern, `rot13 altered ${pattern}`);
  }
});

test('stripJunk removes every digraph rather than substituting one', () => {
  assert.equal(stripJunk('a@$b^^c~@d%?e*~f!!g#&h'), 'abcdefgh');
  assert.equal(stripJunk('no junk here'), 'no junk here');
});

test('regression: stray _ and - must not be read as base64url', () => {
  // Python's b64decode discards non-alphabet characters, so a port that let
  // these through would corrupt the payload on Node only — Node maps _ to /
  // and - to +. The sanitiser in fromBase64 is what prevents that.
  const original = { source: 'https://cdn.example.net/x/index.m3u8' };
  const literal = obfuscate(original);
  const payload = JSON.parse(literal)[0];

  for (const stray of ['_', '-', '_-_']) {
    const polluted = JSON.stringify([payload.slice(0, 10) + stray + payload.slice(10)]);
    assert.deepEqual(deobfuscate(polluted), original, `failed with stray ${stray}`);
  }
});

test('regression: survives payloads with no junk at all', () => {
  const original = { source: 'https://cdn.example.net/y/index.m3u8' };
  assert.deepEqual(deobfuscate(obfuscate(original, 0)), original);
});

test('carries non-ASCII text through both base64 layers intact', () => {
  const original = { title: 'Épisode 4 — 日本語 «quoted» 😀', source: 'https://x.test/a.m3u8' };
  assert.deepEqual(deobfuscate(obfuscate(original)), original);
});

test('handles a nested structure, not just a flat object', () => {
  const original = {
    meta: { title: 'Deep' },
    sources: [{ file: 'https://cdn.example.net/deep/index.m3u8', label: '1080p' }],
  };
  assert.deepEqual(deobfuscate(obfuscate(original)), original);
});

test('reports which step failed instead of returning null', () => {
  assert.throws(() => deobfuscate('["not-actually-obfuscated"]'), DeobfuscationError);

  try {
    deobfuscate('[]');
    assert.fail('expected a throw');
  } catch (error) {
    assert.ok(error instanceof DeobfuscationError);
    assert.equal(error.step, 'input');
  }
});

test('extractPayloadString rejects malformed input', () => {
  assert.throws(() => extractPayloadString(''), DeobfuscationError);
  assert.throws(() => extractPayloadString('[1, 2, 3]'), DeobfuscationError);
  assert.throws(() => extractPayloadString(42), DeobfuscationError);
  assert.equal(extractPayloadString('["abc"]'), 'abc');
});

test('the trace names all seven stages in order', () => {
  const { trace } = deobfuscateWithTrace(obfuscate({ source: 'https://a.test/b.m3u8' }));
  assert.deepEqual(
    trace.map((entry) => entry.step),
    [
      '0. payload',
      '1. rot13',
      '2. strip junk',
      '3. base64 decode',
      `4. charCode -${SHIFT}`,
      '5. reverse',
      '6. base64 decode',
    ],
  );
});

test('shiftCharCodes and reverseString are exact inverses', () => {
  const sample = 'AbC+/=019xyz';
  assert.equal(shiftCharCodes(shiftCharCodes(sample, 3), -3), sample);
  assert.equal(reverseString(reverseString(sample)), sample);
});
