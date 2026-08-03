/**
 * Turns a VOE embed URL into a title plus a playable stream URL.
 *
 * Nothing here parses a DOM — we work over the raw HTML text. VOE inlines the
 * payload inside a `<script>` element, and text scanning avoids the classic
 * BeautifulSoup trap where `script.string` is `None` for any tag with more
 * than one child node, silently skipping the very tag we need.
 */

import { deobfuscate, deobfuscateWithTrace } from './deobfuscate.js';
import { getText } from './http.js';

export class ExtractionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ExtractionError';
  }
}

/** Keys whose values are most likely to be the real stream, best first. */
const PREFERRED_KEYS = ['source', 'hls', 'file', 'manifest', 'url', 'src', 'stream'];

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ',
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (HTML_ENTITIES[key]) return HTML_ENTITIES[key];
    if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
    return match;
  });
}

/**
 * VOE embed pages frequently bounce to a randomly-named mirror domain via
 * JavaScript rather than an HTTP redirect, so `fetch` alone never sees it.
 */
export function findRedirect(html, baseUrl) {
  const patterns = [
    /window\.location\.href\s*=\s*['"]([^'"]+)['"]/i,
    /location\.replace\(\s*['"]([^'"]+)['"]\s*\)/i,
    /window\.location\s*=\s*['"]([^'"]+)['"]/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      try {
        return new URL(match[1], baseUrl).href;
      } catch {
        /* not a usable URL; keep looking */
      }
    }
  }
  return null;
}

/** Pull a human-readable title out of the page, sanitised for use in a filename. */
export function extractTitle(html, url) {
  const candidates = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ];
  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match?.[1]?.trim()) {
      return sanitiseFilename(decodeEntities(match[1]));
    }
  }
  const slug = new URL(url).pathname.split('/').filter(Boolean).pop();
  return sanitiseFilename(slug || 'video');
}

/**
 * Make a string safe as a filename on every platform: no path separators, no
 * reserved characters, no control characters, no leading/trailing dots.
 */
export function sanitiseFilename(name) {
  const cleaned = name
    .replace(/[<>:"/\\|?*]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120)
    .trim();
  return cleaned || 'video';
}

/** Depth-first walk yielding every string in a decoded payload, with its key. */
function* walkStrings(value, key = null) {
  if (typeof value === 'string') {
    yield { key, value };
  } else if (Array.isArray(value)) {
    for (const item of value) yield* walkStrings(item, key);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) yield* walkStrings(child, childKey);
  }
}

/** Some payloads nest one more Base64 layer around the URL itself. */
function maybeDecodeNested(value) {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return /^https?:\/\/\S+$/.test(decoded.trim()) ? decoded.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Collect every plausible stream URL from a decoded payload and rank them:
 * HLS manifests first, then progressive URLs, with well-known keys winning
 * ties. The Python reference returned whichever URL an unordered dict walk hit
 * first, which can pick a preview or thumbnail track instead of the video.
 */
export function collectStreamUrls(payload) {
  const found = new Map();

  for (const { key, value } of walkStrings(payload)) {
    for (const candidate of [value, maybeDecodeNested(value)]) {
      if (!candidate || !/^https?:\/\//i.test(candidate)) continue;
      if (!/\.(m3u8|mp4|mpd)(\?|#|$)/i.test(candidate)) continue;
      if (!found.has(candidate)) found.set(candidate, key);
    }
  }

  const score = ([url, key]) => {
    let value = 0;
    if (/\.m3u8(\?|#|$)/i.test(url)) value += 100;
    if (/\.mp4(\?|#|$)/i.test(url)) value += 50;
    const keyRank = PREFERRED_KEYS.indexOf(String(key ?? '').toLowerCase());
    if (keyRank !== -1) value += 20 - keyRank;
    if (/thumb|preview|sprite|poster|trailer/i.test(url)) value -= 200;
    return value;
  };

  return [...found.entries()]
    .sort((a, b) => score(b) - score(a))
    .map(([url, key]) => ({ url, key }));
}

/** Every `["…"]` literal appearing inside a `<script>` element. */
function candidatePayloads(html) {
  const payloads = [];

  // Strategy 1: the intended location.
  const jsonScript = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(jsonScript)) {
    const body = match[1].trim();
    if (body.startsWith('[')) payloads.push({ source: 'application/json script', text: body });
  }

  // Strategy 2: brute force every script for an array-of-one-string literal.
  const anyScript = /<script[\s\S]*?>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(anyScript)) {
    for (const literal of match[1].matchAll(/\[\s*"([^"\\]{32,})"\s*\]/g)) {
      payloads.push({ source: 'inline script literal', text: `["${literal[1]}"]` });
    }
  }

  return payloads;
}

/** Legacy/plain sources that never went through the obfuscator. */
function plainStreamUrls(html) {
  const results = [];
  const patterns = [
    /["'](?:hls|source|file|manifest)["']\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi,
    /(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const url = (match[1] ?? match[0]).replace(/\\\//g, '/');
      if (!results.includes(url)) results.push(url);
    }
  }
  return results;
}

/**
 * Fetch an embed page and extract the stream.
 *
 * @param {string} url    a VOE embed URL
 * @param {{ debug?: boolean, maxRedirects?: number, referer?: string }} [options]
 *   `referer` is the page that framed this one, when we arrived via an embed
 *   wrapper. http.js turns it into the `Origin`/`Sec-Fetch-Site: cross-site`
 *   pair a browser would send from inside the iframe.
 * @returns {Promise<{ title: string, streamUrl: string, pageUrl: string, strategy: string, candidates: string[], payload: unknown }>}
 */
export async function extractVideo(url, options = {}) {
  const { debug = false, maxRedirects = 3, referer } = options;

  let pageUrl = url;
  let html = '';

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await getText(pageUrl, { referer: hop > 0 ? url : referer });
    html = response.text;
    pageUrl = response.url;

    const next = findRedirect(html, pageUrl);
    if (!next || next === pageUrl) break;
    if (hop === maxRedirects) {
      throw new ExtractionError(`too many JavaScript redirects (last: ${next})`);
    }
    if (debug) console.error(`  → following mirror redirect to ${next}`);
    pageUrl = next;
  }

  const title = extractTitle(html, pageUrl);

  // Strategies 1 and 2: the obfuscated payload.
  const failures = [];
  for (const { source, text } of candidatePayloads(html)) {
    try {
      const payload = debug ? undefined : deobfuscate(text);
      let decoded = payload;
      if (debug) {
        const { result, trace } = deobfuscateWithTrace(text);
        console.error(`  → deobfuscating payload from ${source}:`);
        for (const step of trace) {
          console.error(`      ${step.step.padEnd(20)} ${String(step.length).padStart(6)}  ${step.preview}`);
        }
        decoded = result;
      }

      const candidates = collectStreamUrls(decoded);
      if (candidates.length > 0) {
        return {
          title,
          streamUrl: candidates[0].url,
          pageUrl,
          strategy: source,
          candidates: candidates.map((c) => c.url),
          payload: decoded,
        };
      }
      failures.push(`${source}: decoded cleanly but held no stream URL`);
    } catch (error) {
      failures.push(`${source}: ${error.message}`);
    }
  }

  // Strategies 3 and 4: unobfuscated URLs sitting in the page.
  const plain = plainStreamUrls(html);
  if (plain.length > 0) {
    return {
      title,
      streamUrl: plain[0],
      pageUrl,
      strategy: 'plain URL in page source',
      candidates: plain,
      payload: null,
    };
  }

  const detail = failures.length > 0 ? `\nAttempts:\n  - ${failures.join('\n  - ')}` : '';
  throw new ExtractionError(
    `no stream URL found on ${pageUrl}. VOE may have changed its obfuscation, ` +
      `or the video may have been removed.${detail}`,
  );
}
