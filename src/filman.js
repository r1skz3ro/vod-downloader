/**
 * Collects the embed URLs behind a filman.cc series, so that a season's worth
 * of episodes can be handed to the VOE pipeline without clicking through the
 * site once per episode.
 *
 * The page looks like it needs a browser, but the "click" on a hosting row is
 * an XHR rather than a navigation, so plain HTTP is enough. The inline script
 * on an episode page binds:
 *
 *   var routeToken = '9619c4d7';
 *   $('.link-to-video a').click(function () {
 *     $.get('/link/go/' + id);                          // hit counter
 *     $.ajax({ url: '/link/token',
 *              data: { link_id: linkId2, rt: routeToken },
 *              headers: { 'X-Requested-With': 'XMLHttpRequest' }, … })
 *
 * and builds the "Przejdź do Odtwarzacza." button from `atob(resp.url)`. So the
 * whole flow is: series page -> episode page -> /link/token -> base64 decode,
 * which lands on an embed wrapper that `embed.js` already knows how to unwrap.
 *
 * Observed endpoint behaviour, which shapes the code below:
 *   - `X-Requested-With: XMLHttpRequest` is mandatory; without it the site
 *     answers 400 "Nieprawidłowe żądanie".
 *   - `rt` is optional, but a stale value is rejected with 403 "Nieaktualny
 *     endpoint", so a scraped token is retried without it rather than trusted.
 *   - `/link/go/<id>` only increments a counter; the token works without it.
 *
 * HTML is matched with regexes rather than parsed, the same trade-off
 * extract.js documents: the markup we need is small and stable, and the project
 * carries no dependencies.
 */

import { getText, request } from './http.js';

export const FILMAN_ORIGIN = 'https://filman.cc';

export class FilmanError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'FilmanError';
    /** True when the site turned us away for asking too often, not for good. */
    this.rateLimited = options.rateLimited ?? false;
  }
}

/**
 * True when `error` is the site asking us to slow down.
 *
 * The endpoint signals this two ways — an HTTP 429, and an `ok: false` body
 * carrying "Za szybko, spróbuj za chwilę" ("too fast, try in a moment") — and
 * a plain page fetch signals it only through the status in the message text.
 */
export function isRateLimited(error) {
  if (!error) return false;
  if (error.rateLimited) return true;
  return /\b429\b|za szybko/i.test(error.message ?? '');
}

/** Episode anchors inside the season list, e.g. `[s11e22] Kulisy śmiechu`. */
const EPISODE_PATTERN =
  /<a\s+[^>]*href="([^"]*\/e\/[^"]+)"[^>]*>\s*\[s(\d+)e(\d+)\]\s*([\s\S]*?)<\/a>/gi;

const SEASON_HEADING = /<span>\s*Sezon\s+(\d+)\s*<\/span>/gi;

const ROUTE_TOKEN = /\brouteToken\s*=\s*['"]([^'"]+)['"]/;

/** Collapse the page's generous indentation into a single-line title. */
const tidy = (text) => text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

const pad = (n) => String(n).padStart(2, '0');

/**
 * The seasons of a series page, each with its episodes, both in ascending
 * order — the site lists newest first.
 *
 * The season list is nested (`<li><span>Sezon N</span><ul><li>…episode…</li>`),
 * so splitting on `<li>` would not separate seasons from their episodes.
 * Splitting on the `Sezon` headings instead gives one chunk per season.
 *
 * @param {string} html
 * @param {string} [baseUrl] resolves relative episode hrefs
 * @returns {{ number: number, episodes: object[] }[]}
 */
export function parseSeasons(html, baseUrl = FILMAN_ORIGIN) {
  const listStart = html.search(/<ul[^>]*\bid="episode-list"/i);
  const scope = listStart === -1 ? html : html.slice(listStart);

  const headings = [...scope.matchAll(SEASON_HEADING)];
  if (headings.length === 0) return [];

  const seasons = [];
  for (const [index, heading] of headings.entries()) {
    const from = heading.index + heading[0].length;
    const to = headings[index + 1]?.index ?? scope.length;
    const number = Number(heading[1]);

    const episodes = [];
    for (const match of scope.slice(from, to).matchAll(EPISODE_PATTERN)) {
      const [, href, season, episode, title] = match;
      let url;
      try {
        url = new URL(href, baseUrl).href;
      } catch {
        continue; // an href we cannot resolve is not an episode we can fetch
      }
      episodes.push({
        season: Number(season),
        episode: Number(episode),
        label: `s${pad(season)}e${pad(episode)}`,
        title: tidy(title),
        url,
      });
    }

    episodes.sort((a, b) => a.episode - b.episode);
    seasons.push({ number, episodes });
  }

  seasons.sort((a, b) => a.number - b.number);
  return seasons;
}

/**
 * The hosting rows on an episode page that point at VOE, in page order.
 *
 * `data-link-id` is what the page's own handler prefers, falling back to
 * `data-id`. `mp4` carries the page's alternative branch: when it is set the
 * anchor's `href` is itself a base64'd source and no token call is needed.
 *
 * @param {string} html
 * @returns {{ id: string, mp4: string | null, href: string | null }[]}
 */
export function findVoeLinks(html) {
  const found = [];
  // Anchors live inside `<td class="link-to-video">`; matching the anchor and
  // then checking for `voe.` in its body avoids depending on the cell markup.
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const [, attrs, body] = match;
    const id = attribute(attrs, 'data-link-id') ?? attribute(attrs, 'data-id');
    if (!id) continue;
    if (!/voe\./i.test(body)) continue;
    found.push({ id, mp4: attribute(attrs, 'data-mp4'), href: attribute(attrs, 'href') });
  }
  return found;
}

function attribute(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match ? match[1] : null;
}

/** The per-page-load token the `/link/token` endpoint validates, if present. */
export function findRouteToken(html) {
  return html.match(ROUTE_TOKEN)?.[1] ?? null;
}

/** The site returns the player URL base64'd, exactly as `atob` would take it. */
export function decodePlayerUrl(encoded) {
  const decoded = Buffer.from(String(encoded).replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString(
    'utf8',
  );
  if (!/^https?:\/\/\S+$/.test(decoded)) {
    throw new FilmanError(`the site returned something that is not a URL: ${decoded.slice(0, 80)}`);
  }
  return decoded;
}

/**
 * How many times the HTTP layer may retry the token call itself.
 *
 * Lower than the default: callers pace this endpoint across a whole run and
 * wait out a refusal there, so a long retry budget here would only stall the
 * run before that pacing gets a say.
 */
const TOKEN_RETRIES = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait between loading an episode page and asking for its token.
 *
 * On the site the token call is an XHR behind a click, so it lands a moment
 * after the page rather than in the same instant. Firing both back to back is
 * two requests in as many milliseconds, which is the pattern a limiter watches
 * for; a pause here is the cheapest way not to look like one.
 */
const CLICK_DELAY = 700;

async function callTokenEndpoint(linkId, { routeToken, referer, retries = TOKEN_RETRIES }) {
  const url = new URL('/link/token', FILMAN_ORIGIN);
  url.searchParams.set('link_id', linkId);
  if (routeToken) url.searchParams.set('rt', routeToken);

  // Referer goes through `headers` rather than the `referer` option: the latter
  // also sets Origin and flips Sec-Fetch-Site to cross-site, which misdescribes
  // what is a same-origin XHR.
  const response = await request(url.href, {
    retries,
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      ...(referer ? { Referer: referer } : {}),
    },
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new FilmanError(
      `/link/token answered with ${response.status} and a non-JSON body; ` +
        `the cookies are probably stale or Cloudflare intercepted the request`,
      { cause: error },
    );
  }
  return { status: response.status, payload };
}

/**
 * Ask the site for the player URL behind one hosting row.
 *
 * A scraped `routeToken` is sent when we have one, but a rejected token is not
 * fatal: the parameter is optional, so we drop it and try once more.
 *
 * @param {string} linkId
 * @param {{ routeToken?: string | null, referer?: string, retries?: number }} [options]
 * @returns {Promise<string>}
 */
export async function requestEmbedUrl(linkId, options = {}) {
  const { routeToken, referer, retries } = options;

  let { status, payload } = await callTokenEndpoint(linkId, { routeToken, referer, retries });

  // The token-less retry exists for a *rejected token*. When the refusal is a
  // rate limit the token is beside the point, and retrying immediately spends
  // another request against the very budget we just exhausted — so don't.
  const limited = () => status === 429 || /za szybko/i.test(payload?.error ?? '');
  if (!payload?.ok && routeToken && !limited()) {
    ({ status, payload } = await callTokenEndpoint(linkId, { referer, retries }));
  }

  if (!payload?.ok) {
    throw new FilmanError(
      `the site refused to hand out the player link (HTTP ${status}${
        payload?.error ? `: ${payload.error}` : ''
      })`,
      { rateLimited: limited() },
    );
  }
  return decodePlayerUrl(payload.url);
}

/**
 * The embed URL behind an episode page's VOE row.
 *
 * @param {string} episodeUrl
 * @param {{ referer?: string, clickDelay?: number }} [options]
 * @returns {Promise<string>}
 */
export async function resolveEpisode(episodeUrl, options = {}) {
  const { referer, clickDelay = CLICK_DELAY } = options;

  let html;
  let pageUrl = episodeUrl;
  try {
    const response = await getText(episodeUrl, {
      headers: referer ? { Referer: referer } : {},
    });
    html = response.text;
    pageUrl = response.url;
  } catch (error) {
    throw new FilmanError(`could not load ${episodeUrl}: ${error.message}`, {
      cause: error,
      rateLimited: isRateLimited(error),
    });
  }

  const links = findVoeLinks(html);
  if (links.length === 0) {
    throw new FilmanError('no voe.sx hosting is listed for this episode');
  }

  const [link] = links;
  // The page plays `data-mp4` rows straight from a base64'd href instead of
  // asking the token endpoint, so mirror that rather than making a doomed call.
  if (link.mp4 != null && link.href && link.href !== '#') {
    return decodePlayerUrl(link.href); // no second request, so nothing to pace
  }

  if (clickDelay > 0) await sleep(clickDelay + Math.random() * clickDelay);
  return requestEmbedUrl(link.id, { routeToken: findRouteToken(html), referer: pageUrl });
}

/**
 * Fetch a series page and return its seasons.
 *
 * @param {string} seriesUrl
 * @returns {Promise<{ number: number, episodes: object[] }[]>}
 */
export async function fetchSeasons(seriesUrl) {
  let html;
  let pageUrl = seriesUrl;
  try {
    const response = await getText(seriesUrl);
    html = response.text;
    pageUrl = response.url;
  } catch (error) {
    throw new FilmanError(`could not load ${seriesUrl}: ${error.message}`, { cause: error });
  }

  const seasons = parseSeasons(html, pageUrl);
  if (seasons.length === 0) {
    throw new FilmanError(
      `no episode list found on ${pageUrl}. Check that this is a series page (/s/…), ` +
        `and that the cookies are still valid.`,
    );
  }
  return seasons;
}
