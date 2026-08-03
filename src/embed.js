/**
 * Resolves an intermediate embed page down to the VOE URL it wraps.
 *
 * Links are rarely shared as bare voe.sx URLs; they arrive wrapped in a
 * third-party player page that frames the real one. Those pages seldom ship a
 * usable `src` attribute — the one this was built against declares a bare
 * `<iframe id="pl">` and assigns `iframe.src` from JavaScript only after a
 * click-through overlay, with the URL held as a base64'd XOR ciphertext whose
 * key is spliced together from three short literals:
 *
 *   var _e = 'XE1MSENfFkoUXgcYF0sYABsBQQoEHF0dBksWWgc=';
 *   var _a = '49880'; var _b = 'e9eb1b'; var _c = '6d37e';
 *   var src = _xd(_e, _a + _b + _c);
 *
 * So scanning for `src="…"` finds nothing and we have to reverse the cipher,
 * much as `deobfuscate.js` does for VOE's own payload. Rather than pin the
 * variable names, which are regenerated per page, we recover the operands
 * structurally and fall back to trying every literal pairing, accepting only
 * what decodes to a well-formed URL.
 */

import { getText } from './http.js';

export class EmbedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'EmbedError';
  }
}

/** A decoded candidate only counts if it looks like a bare absolute URL. */
const URL_PATTERN = /^https?:\/\/[^\s'"<>]+$/;

/** Frame sources that are placeholders rather than a real destination. */
const PLACEHOLDER_SRC = /^(?:about:|data:|javascript:|blob:|#)/i;

const SCRIPT_PATTERN = /<script[\s\S]*?>([\s\S]*?)<\/script>/gi;

/** True for `voe.sx` and its mirrors, false for lookalikes such as `notvoe.com`. */
export function isVoeHost(hostname) {
  return /(^|\.)voe\./i.test(hostname);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const isVoeUrl = (url) => isVoeHost(hostOf(url) ?? '');

/**
 * The `src` of the first `<iframe>` that points somewhere real.
 *
 * Relative values are resolved against `baseUrl`, matching how `findRedirect`
 * in extract.js handles the mirror hop.
 */
export function findIframeSrc(html, baseUrl) {
  for (const tag of html.matchAll(/<iframe\b[^>]*>/gi)) {
    const match = tag[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    const value = match?.[1]?.trim().replace(/&amp;/gi, '&');
    if (!value || PLACEHOLDER_SRC.test(value)) continue;
    try {
      return new URL(value, baseUrl).href;
    } catch {
      /* not a usable URL; keep looking */
    }
  }
  return null;
}

/**
 * Reverse the page's cipher: base64-decode, then XOR against a repeating key.
 *
 * The bytes are read as latin1 because that is what `atob` hands the browser —
 * decoding as utf8 would mangle every byte above 0x7f before the XOR runs.
 */
export function xorDecode(payload, key) {
  if (!payload || !key) return '';
  const normalised = payload.replace(/-/g, '+').replace(/_/g, '/');
  const raw = Buffer.from(normalised, 'base64').toString('latin1');
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    out += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

/**
 * Every `name = "literal"` string assignment inside a `<script>`, in source
 * order. The leading guard skips property writes such as `el.style.opacity`,
 * which would otherwise bury the operands we want under UI noise.
 */
function stringAssignments(html) {
  const found = [];
  const assignment =
    /(?:^|[^.\w$])(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"\\]*)\2/g;
  for (const script of html.matchAll(SCRIPT_PATTERN)) {
    for (const match of script[1].matchAll(assignment)) {
      found.push({ name: match[1], value: match[3] });
    }
  }
  return found;
}

/**
 * Tier 1: find the decode call itself — `f(payload, a + b + c)` — and resolve
 * each identifier back to its literal. Survives renamed variables and any
 * number of key fragments.
 */
function structuralCandidates(html, byName) {
  const results = [];
  const call =
    /[A-Za-z_$][\w$]*\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*(?:\s*\+\s*[A-Za-z_$][\w$]*)*)\s*\)/g;

  for (const match of html.matchAll(call)) {
    const payload = byName.get(match[1]);
    if (payload === undefined) continue;
    const parts = match[2].split('+').map((part) => part.trim());
    if (!parts.every((part) => byName.has(part))) continue;
    results.push(xorDecode(payload, parts.map((part) => byName.get(part)).join('')));
  }
  return results;
}

/**
 * Tier 2: no recognisable call, so pair every base64-shaped literal with every
 * literal and every run of up to four consecutive ones — the latter is what
 * recovers a spliced key when the call has been restructured. Only a decode
 * that yields a valid URL survives, and these pages carry few enough literals
 * that the search space stays trivial.
 */
function bruteForceCandidates(literals) {
  const payloads = literals.filter(
    ({ value }) => value.length >= 16 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(value),
  );
  if (payloads.length === 0) return [];

  const keys = new Set();
  for (let start = 0; start < literals.length; start++) {
    for (let span = 1; span <= 4 && start + span <= literals.length; span++) {
      const key = literals
        .slice(start, start + span)
        .map((literal) => literal.value)
        .join('');
      if (key) keys.add(key);
    }
  }

  const results = [];
  for (const { value } of payloads) {
    for (const key of keys) results.push(xorDecode(value, key));
  }
  return results;
}

/**
 * Every URL recoverable from the page's obfuscated player source, VOE hosts
 * first. Returns `[]` when the page holds nothing that decodes cleanly.
 */
export function decodeObfuscatedSrc(html) {
  const literals = stringAssignments(html);
  const byName = new Map();
  for (const { name, value } of literals) {
    if (!byName.has(name)) byName.set(name, value);
  }

  let decoded = structuralCandidates(html, byName).filter((value) => URL_PATTERN.test(value));
  if (decoded.length === 0) {
    decoded = bruteForceCandidates(literals).filter((value) => URL_PATTERN.test(value));
  }

  return [...new Set(decoded)].sort((a, b) => Number(isVoeUrl(b)) - Number(isVoeUrl(a)));
}

/**
 * The URL an embed page frames, from a plain `src` or the obfuscated payload.
 * A VOE host wins outright; otherwise a real `src` is preferred.
 */
export function findEmbeddedUrl(html, baseUrl) {
  const candidates = [];

  const direct = findIframeSrc(html, baseUrl);
  if (direct) candidates.push(direct);

  for (const decoded of decodeObfuscatedSrc(html)) {
    try {
      candidates.push(new URL(decoded, baseUrl).href);
    } catch {
      /* decoded to something unusable; skip it */
    }
  }

  return candidates.find(isVoeUrl) ?? candidates[0] ?? null;
}

/**
 * Follow an embed page to the VOE URL it wraps.
 *
 * A URL that is already on a VOE host is returned untouched, without a request,
 * so direct links behave exactly as they always have.
 *
 * @param {string} url
 * @param {{ debug?: boolean, maxHops?: number }} [options]
 * @returns {Promise<string>}
 */
export async function resolveEmbedUrl(url, options = {}) {
  const { debug = false, maxHops = 2 } = options;
  if (isVoeUrl(url)) return url;

  let pageUrl = url;
  let referer;

  for (let hop = 0; hop < maxHops; hop++) {
    let html;
    let resolved;
    try {
      const response = await getText(pageUrl, { referer });
      html = response.text;
      resolved = response.url;
    } catch (error) {
      throw new EmbedError(`could not load the embed page ${pageUrl}: ${error.message}`, {
        cause: error,
      });
    }

    const next = findEmbeddedUrl(html, resolved);
    if (!next) {
      // Only the page we were handed has to be an embed wrapper. Deeper hops
      // landing on a player page without a frame means we have already arrived.
      if (hop === 0) {
        throw new EmbedError(
          `no iframe source found on ${resolved}. The page may not be an embed wrapper, ` +
            `or its obfuscation has changed.`,
        );
      }
      return pageUrl;
    }

    if (debug) console.error(`  → resolved embed to ${next}`);
    if (isVoeUrl(next)) return next;

    referer = resolved;
    pageUrl = next;
  }

  return pageUrl;
}
