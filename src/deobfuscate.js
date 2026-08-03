/**
 * Reverses VOE's client-side obfuscation of the stream manifest URL.
 *
 * The page ships a JSON array holding one long string. That string is the
 * manifest metadata put through six reversible transforms. Undoing them in
 * order hands back the original JSON object:
 *
 *   1. ROT13
 *   2. remove seven fixed "junk" digraphs
 *   3. Base64 decode
 *   4. subtract 3 from every character code
 *   5. reverse
 *   6. Base64 decode  -> UTF-8 JSON
 *
 * None of this is encryption: the browser performs exactly these steps
 * locally, with no server involvement, so everything needed to undo it is
 * already in our hands. See README.md for the long-form explanation.
 */

/** Amount subtracted from each character code in step 4. */
export const SHIFT = 3;

/**
 * Filler digraphs VOE splices into the Base64 text to break naive decoders.
 * Note none of them contain letters, so ROT13 leaves them untouched — which
 * is why steps 1 and 2 commute.
 */
export const JUNK_PATTERNS = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];

export class DeobfuscationError extends Error {
  constructor(step, message, options) {
    super(`deobfuscation failed at step "${step}": ${message}`, options);
    this.name = 'DeobfuscationError';
    this.step = step;
  }
}

/** Step 1. Rotate letters by 13; leaves every other character alone. */
export function rot13(text) {
  return text.replace(/[a-z]/gi, (char) => {
    const code = char.charCodeAt(0);
    const base = code < 97 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

/** Step 2. Delete the junk digraphs outright (they are *removed*, not replaced). */
export function stripJunk(text) {
  let out = text;
  for (const pattern of JUNK_PATTERNS) {
    out = out.split(pattern).join('');
  }
  return out;
}

/**
 * Steps 3 and 6. Base64 decode into a *binary string* — one character per
 * byte — which is what JavaScript's `atob()` produces and therefore what the
 * original obfuscator round-trips through.
 *
 * The sanitising pass is load-bearing, not cosmetic. Node's Base64 decoder
 * also accepts the base64url alphabet, so a stray `_` or `-` silently decodes
 * as `/` or `+` and corrupts everything downstream. Python's `b64decode`
 * discards such characters instead, so a literal port without this line would
 * fail only on Node. Dropping every non-alphabet byte reproduces the lenient
 * behaviour the payload is built against.
 */
export function fromBase64(text, step = 'base64') {
  const cleaned = text.replace(/[^A-Za-z0-9+/=]/g, '');
  if (cleaned.length === 0) {
    throw new DeobfuscationError(step, 'no Base64 characters left after sanitising');
  }
  const decoded = Buffer.from(cleaned, 'base64').toString('latin1');
  if (decoded.length === 0) {
    throw new DeobfuscationError(step, `input of ${cleaned.length} chars decoded to nothing`);
  }
  return decoded;
}

/** Step 4. Shift every character code down by `amount`. */
export function shiftCharCodes(text, amount = SHIFT) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(text.charCodeAt(i) - amount);
  }
  return out;
}

/**
 * Step 5. Reverse by code unit. The input is always a binary string from
 * `fromBase64`, so every code unit is a single byte and this is a true byte
 * reversal.
 */
export function reverseString(text) {
  let out = '';
  for (let i = text.length - 1; i >= 0; i--) {
    out += text[i];
  }
  return out;
}

/**
 * Accepts either the raw `["…"]` literal lifted out of the page or the bare
 * payload string, and returns the payload.
 */
export function extractPayloadString(input) {
  if (typeof input !== 'string') {
    throw new DeobfuscationError('input', `expected a string, got ${typeof input}`);
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new DeobfuscationError('input', 'empty input');
  }
  if (!trimmed.startsWith('[')) {
    return trimmed;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new DeobfuscationError('input', 'looks like a JSON array but does not parse', { cause });
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || !parsed[0]) {
    throw new DeobfuscationError('input', 'expected a JSON array whose first element is a string');
  }
  return parsed[0];
}

/**
 * Runs the full pipeline and returns the decoded object, plus a per-step trace
 * useful for `--debug` and for the walkthrough in the README.
 *
 * @returns {{ result: unknown, trace: Array<{ step: string, length: number, preview: string }> }}
 */
export function deobfuscateWithTrace(input) {
  const trace = [];
  const record = (step, value) => {
    trace.push({
      step,
      length: value.length,
      preview: value.length > 72 ? `${value.slice(0, 72)}…` : value,
    });
    return value;
  };

  let value = record('0. payload', extractPayloadString(input));
  value = record('1. rot13', rot13(value));
  value = record('2. strip junk', stripJunk(value));
  value = record('3. base64 decode', fromBase64(value, 'base64 #1'));
  value = record(`4. charCode -${SHIFT}`, shiftCharCodes(value, SHIFT));
  value = record('5. reverse', reverseString(value));
  value = record('6. base64 decode', fromBase64(value, 'base64 #2'));

  // The final layer is UTF-8 JSON; re-encode the binary string to get there.
  const json = Buffer.from(value, 'latin1').toString('utf8');
  let result;
  try {
    result = JSON.parse(json);
  } catch (cause) {
    throw new DeobfuscationError('json', `decoded payload is not valid JSON: ${cause.message}`, { cause });
  }
  return { result, trace };
}

/** Runs the full pipeline and returns just the decoded object. */
export function deobfuscate(input) {
  return deobfuscateWithTrace(input).result;
}
