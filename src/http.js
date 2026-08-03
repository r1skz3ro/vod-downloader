/**
 * Thin fetch wrapper with the two things VOE actually requires:
 *
 *  - a cookie jar. voe.sx is fronted by DDoS-Guard, which hands out
 *    `__ddg1_`/`__ddg8_`/`__ddg9_`/`__ddg10_` on first contact and expects
 *    them back on every subsequent request. Node's global `fetch` does not
 *    persist cookies, so we do it here.
 *  - a browser-shaped `User-Agent` plus a `Referer` on CDN requests, which
 *    the delivery nodes check before serving the manifest and segments.
 */

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

/**
 * The `Sec-CH-UA*` client hints Chrome sends alongside its User-Agent.
 *
 * They have to be derived from the UA rather than hardcoded: `setUserAgent`
 * exists so a borrowed `cf_clearance` can travel with the UA that earned it,
 * and a UA claiming Chrome 148 while the hints still say 126 is a worse signal
 * than sending no hints at all.
 *
 * Returns nothing for a UA that is not Chromium-shaped — Firefox and Safari do
 * not send these headers, so inventing them would be the same mismatch in the
 * other direction.
 *
 * @param {string} ua
 * @returns {Record<string, string>}
 */
export function clientHintsFor(ua) {
  const version = ua.match(/\bChrome\/(\d+)/)?.[1];
  if (!version || /\bFirefox\//.test(ua)) return {};

  const platform = /\bMac OS X\b/.test(ua)
    ? 'macOS'
    : /\bWindows\b/.test(ua)
      ? 'Windows'
      : /\bAndroid\b/.test(ua)
        ? 'Android'
        : /\b(iPhone|iPad)\b/.test(ua)
          ? 'iOS'
          : 'Linux';

  // The "Not)A;Brand" entry is the GREASE value Chrome varies to keep parsers
  // honest; a fixed one is still the shape every Chromium build sends.
  return {
    'Sec-CH-UA': `"Chromium";v="${version}", "Google Chrome";v="${version}", "Not)A;Brand";v="99"`,
    'Sec-CH-UA-Mobile': /\b(Android|iPhone)\b/.test(ua) ? '?1' : '?0',
    'Sec-CH-UA-Platform': `"${platform}"`,
  };
}

const BASE_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  ...clientHintsFor(USER_AGENT),
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * The `Sec-Fetch-Site` value a browser would send for `target` when the request
 * comes from a page at `referer`.
 *
 * Getting this from the pair rather than hardcoding it matters because the two
 * ways of setting a Referer used to disagree: the `referer` option always said
 * `cross-site`, while a Referer passed through raw `headers` left the default
 * `none` in place — a Referer with `Sec-Fetch-Site: none` is a combination no
 * browser produces.
 *
 * @param {string} target
 * @param {string | undefined} referer
 * @returns {string}
 */
export function fetchSiteFor(target, referer) {
  if (!referer) return 'none';

  let from;
  let to;
  try {
    from = new URL(referer);
    to = new URL(target);
  } catch {
    return 'cross-site';
  }

  if (from.origin === to.origin) return 'same-origin';

  // "Same site" is schemefully same-site: an http/https pair is cross-site even
  // when the host matches.
  return from.protocol === to.protocol &&
    registrableDomain(from.hostname) === registrableDomain(to.hostname)
    ? 'same-site'
    : 'cross-site';
}

/**
 * The last two labels of a hostname, as a stand-in for the registrable domain.
 *
 * A real answer needs the public suffix list, which this project will not carry
 * a dependency for. The approximation only mislabels `same-site` as
 * `cross-site` under multi-label suffixes such as `co.uk`, and neither of the
 * hosts we talk to is one.
 */
function registrableDomain(hostname) {
  return hostname.toLowerCase().split('.').slice(-2).join('.');
}

/** `${domain}\t${name}` -> { name, value, domain } */
const jar = new Map();

function normaliseDomain(domain) {
  return domain.replace(/^\./, '').toLowerCase();
}

/** True when `host` is `domain` or a subdomain of it. */
function domainMatches(host, domain) {
  const h = host.toLowerCase();
  const d = normaliseDomain(domain);
  return h === d || h.endsWith(`.${d}`);
}

/** Record the cookies from one `Set-Cookie` header line. */
function storeCookie(line, requestHost) {
  const [pair, ...attrs] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq < 1) return;

  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();

  let domain = requestHost;
  for (const attr of attrs) {
    const [key, val] = attr.split('=');
    if (key?.trim().toLowerCase() === 'domain' && val) {
      domain = normaliseDomain(val.trim());
    }
  }
  jar.set(`${domain}\t${name}`, { name, value, domain });
}

function rememberCookies(response, requestHost) {
  // Node 20+ exposes getSetCookie(); fall back to the folded header.
  const lines =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  for (const line of lines) storeCookie(line, requestHost);
}

/** The `Cookie` header value to send to `url`, or `''` if we hold none. */
export function cookieHeaderFor(url) {
  const host = new URL(url).hostname;
  const parts = [];
  for (const { name, value, domain } of jar.values()) {
    if (domainMatches(host, domain)) parts.push(`${name}=${value}`);
  }
  return parts.join('; ');
}

/** Drop every stored cookie. Used by the interactive loop between URLs. */
export function clearCookies() {
  jar.clear();
}

/**
 * Seed the jar from a browser `Cookie` header, e.g. one copied out of DevTools.
 *
 * Sites behind Cloudflare hand out `cf_clearance` only after a challenge we
 * cannot solve here, so the clearance has to be borrowed from a real browser
 * session; filman.cc also needs its `PHPSESSID`.
 */
export function setCookies(cookieString, domain) {
  const target = normaliseDomain(domain);
  for (const pair of cookieString.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) jar.set(`${target}\t${name}`, { name, value, domain: target });
  }
}

/**
 * Replace the User-Agent sent on every request.
 *
 * Cloudflare binds `cf_clearance` to the exact UA that solved the challenge, so
 * a borrowed cookie is only good alongside the UA of the browser it came from.
 */
export function setUserAgent(ua) {
  if (!ua) return;
  BASE_HEADERS['User-Agent'] = ua;

  // The hints describe the UA, so they are replaced wholesale rather than
  // merged: a Chrome UA swapped for a Firefox one must drop them entirely.
  for (const name of ['Sec-CH-UA', 'Sec-CH-UA-Mobile', 'Sec-CH-UA-Platform']) {
    delete BASE_HEADERS[name];
  }
  Object.assign(BASE_HEADERS, clientHintsFor(ua));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before retrying a rate-limited request.
 *
 * A 429 is not a transient fault that a few hundred milliseconds will clear:
 * the server is asking to be left alone, and retrying on the fault schedule
 * spends the budget for the *next* request on a call that is going to be
 * refused anyway. So rate limiting backs off from seconds, and defers to the
 * server's own `Retry-After` when it sends one.
 */
const RATE_LIMIT_BACKOFF = 5_000;
const RATE_LIMIT_BACKOFF_MAX = 60_000;

/** The wait `Retry-After` asks for in ms, or null when absent or unparseable. */
function retryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(header); // the header's other form is an HTTP date
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * Two separate budgets, because they measure different things. Waiting for a
 * delivery node to answer at all is a sign of trouble after a few seconds;
 * streaming a multi-megabyte segment off a slow one legitimately takes much
 * longer. One combined deadline has to be set to the larger of the two, which
 * makes a dead host take minutes to fail.
 */
const RESPONSE_TIMEOUT = 30_000;
const BODY_TIMEOUT = 120_000;

/** The rejection `AbortSignal.timeout` produces, which callers may match on. */
function timeoutError() {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

/**
 * An abort signal on a timer that can be re-armed, so the response and its
 * body can be given different budgets while sharing one controller.
 *
 * The timer is unref'd: a request abandoned mid-flight must not keep the
 * process alive waiting for a deadline nobody is listening for.
 */
function startDeadline(ms) {
  const controller = new AbortController();
  let timer;

  const arm = (delay) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(timeoutError()), delay);
    timer.unref?.();
  };

  arm(ms);
  return { signal: controller.signal, arm, clear: () => clearTimeout(timer) };
}

/**
 * One request with cookies, headers, and retries.
 *
 * `read` decides who consumes the body. With 'text' or 'buffer' it is read
 * here, inside the retry loop, so a stall partway through the body is retried
 * like any other transient fault instead of escaping as a bare TimeoutError.
 * With null the Response is handed back unread, and the body deadline is left
 * armed for whoever reads it.
 */
async function perform(url, options, read) {
  const {
    referer,
    headers = {},
    retries = 3,
    timeout = RESPONSE_TIMEOUT,
    bodyTimeout = BODY_TIMEOUT,
    method = 'GET',
    ...rest
  } = options;

  const host = new URL(url).hostname;
  let lastError;
  let wait = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (wait > 0) await sleep(wait);

    const merged = { ...BASE_HEADERS, ...headers };
    if (referer) {
      merged.Referer = referer;
      merged.Origin = new URL(referer).origin;
    }
    // Derived from whichever Referer is actually going out — the option above or
    // one the caller passed through `headers` — unless the caller said itself.
    if (!('Sec-Fetch-Site' in headers)) {
      merged['Sec-Fetch-Site'] = fetchSiteFor(url, merged.Referer);
    }
    const cookie = cookieHeaderFor(url);
    if (cookie) merged.Cookie = cookie;

    const clock = startDeadline(timeout);
    try {
      const response = await fetch(url, {
        ...rest,
        method,
        headers: merged,
        redirect: 'follow',
        signal: clock.signal,
      });
      rememberCookies(response, host);

      // Retry only on rate limiting and server-side faults.
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
        if (attempt < retries) {
          clock.clear();
          wait =
            response.status === 429
              ? (retryAfterMs(response) ??
                Math.min(RATE_LIMIT_BACKOFF * 2 ** attempt, RATE_LIMIT_BACKOFF_MAX))
              : Math.min(500 * 2 ** attempt, 4000);
          continue;
        }
      }

      clock.arm(bodyTimeout);
      if (!read) return { response, body: undefined };

      const body =
        read === 'text' ? await response.text() : Buffer.from(await response.arrayBuffer());
      clock.clear();
      return { response, body };
    } catch (error) {
      clock.clear();
      lastError = error;
      wait = Math.min(500 * 2 ** attempt, 4000);
    }
  }
  throw new Error(`request failed after ${retries + 1} attempts: ${lastError?.message}`, {
    cause: lastError,
  });
}

/**
 * `fetch` with cookie persistence, sane headers, and retry on transient
 * failures. Returns the raw Response; callers decide how to read the body.
 *
 * A body read the caller does itself is outside the retry loop — prefer
 * `getText`/`getBuffer` unless the status is needed alongside the body.
 */
export async function request(url, options = {}) {
  const { response } = await perform(url, options, null);
  return response;
}

/** Fetch and return the body as text, throwing on a non-2xx status. */
export async function getText(url, options = {}) {
  const { response, body } = await perform(url, options, 'text');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  return { text: body, url: response.url || url };
}

/** Fetch and return the body as a Buffer, throwing on a non-2xx status. */
export async function getBuffer(url, options = {}) {
  const { response, body } = await perform(url, options, 'buffer');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  return body;
}
