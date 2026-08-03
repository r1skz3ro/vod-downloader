import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePlayerUrl,
  findRouteToken,
  findVoeLinks,
  isRateLimited,
  parseSeasons,
  requestEmbedUrl,
} from '../src/filman.js';
import { formatSelection, parseSelection } from '../src/prompt.js';
import { collectLinks, formatResumeCommand } from '../bin/filman.js';

const PLAYER = 'https://embed.tmp-url.pro/7621610/1785100567/a2353051cd1b9327/';

/**
 * A stand-in for the series page: seasons newest-first, episodes newest-first
 * within each, and the deep indentation the real template emits. Tests build
 * their own markup rather than shipping a captured page, as the embed and
 * deobfuscate suites do.
 */
function seriesPage(seasons) {
  const items = seasons
    .map(
      ([number, episodes]) => `
        <li>
            <span>Sezon ${number}</span>
            <ul>
${episodes
  .map(
    ([episode, title]) => `                <li>
                    <img src="https://filman.cc/public/dist/images/star.png">
                    <a href="https://filman.cc/e/some-show/${number}${episode}/slug/0">
                        [s${number}e${String(episode).padStart(2, '0')}] ${title}                                   </a>
                </li>`,
  )
  .join('\n')}
            </ul>
        </li>`,
    )
    .join('\n');
  return `<h4>Odcinki</h4><ul id="episode-list">${items}</ul>`;
}

/** One hosting row as the episode page renders it. */
function hostingRow(host, { id, linkId, mp4, href = '#' } = {}) {
  const attrs = [
    `href="${href}"`,
    id ? `data-id="${id}"` : '',
    linkId ? `data-link-id="${linkId}"` : '',
    mp4 ? `data-mp4="${mp4}"` : '',
  ]
    .filter(Boolean)
    .join('\n                ');
  return `<tr class="version">
        <td style="width: 100%" class="link-to-video">
            <a ${attrs}>
                <img src="https://filman.cc/public/static/favicons/${host.replace('.', '_')}.png" alt="${host}">
                ${host} dodane miesiąc temu            </a>
        </td>
    </tr>`;
}

function episodePage(rows, { routeToken = '9619c4d7' } = {}) {
  return `<div id="link-list"><table id="links"><tbody>
${rows.join('\n')}
</tbody></table></div>
<script>
window.jqReady = function () {
    var routeToken = '${routeToken}';
    $('.link-to-video a').click(function (event) { event.preventDefault(); });
}
</script>`;
}

test('parseSeasons reads a nested season list and sorts it ascending', () => {
  const seasons = parseSeasons(
    seriesPage([
      [11, [[22, 'Kulisy śmiechu'], [21, 'Ta szalona, szalona Marge']]],
      [2, [[3, 'Drugi odcinek']]],
    ]),
  );

  assert.deepEqual(
    seasons.map((season) => season.number),
    [2, 11],
    'the page lists newest first; we present oldest first',
  );
  assert.deepEqual(
    seasons[1].episodes.map((ep) => ep.episode),
    [21, 22],
    'episodes are re-sorted within a season too',
  );
});

test('parseSeasons keeps each season\'s episodes out of its neighbours', () => {
  // The list is nested, so a parser that split on <li> would fold every
  // episode into the first season.
  const seasons = parseSeasons(
    seriesPage([
      [3, [[2, 'B'], [1, 'A']]],
      [1, [[1, 'C']]],
    ]),
  );
  assert.deepEqual(seasons.map((season) => season.episodes.length), [1, 2]);
  assert.equal(seasons[0].number, 1);
  assert.equal(seasons[0].episodes[0].title, 'C');
});

test('parseSeasons extracts the label, title and absolute URL', () => {
  const [season] = parseSeasons(seriesPage([[11, [[22, 'Kulisy śmiechu']]]]));
  assert.deepEqual(season.episodes[0], {
    season: 11,
    episode: 22,
    label: 's11e22',
    title: 'Kulisy śmiechu',
    url: 'https://filman.cc/e/some-show/1122/slug/0',
  });
});

test('parseSeasons collapses the template\'s trailing whitespace in titles', () => {
  const [season] = parseSeasons(seriesPage([[1, [[1, 'Ta   szalona,\n  szalona Marge']]]]));
  assert.equal(season.episodes[0].title, 'Ta szalona, szalona Marge');
});

test('parseSeasons resolves relative episode hrefs against the page URL', () => {
  const html = seriesPage([[1, [[1, 'A']]]]).replace('https://filman.cc/e/', '/e/');
  const [season] = parseSeasons(html, 'https://filman.cc/s/673/some-show');
  assert.equal(season.episodes[0].url, 'https://filman.cc/e/some-show/11/slug/0');
});

test('parseSeasons returns nothing for a page with no episode list', () => {
  assert.deepEqual(parseSeasons('<html><body>a film, not a series</body></html>'), []);
});

test('findVoeLinks picks the voe row and prefers data-link-id', () => {
  const html = episodePage([
    hostingRow('rapidvid.net', { id: '111' }),
    hostingRow('voe.sx', { id: '7621610', linkId: '7621611' }),
  ]);
  const links = findVoeLinks(html);
  assert.equal(links.length, 1, 'the non-voe hosting must be ignored');
  assert.equal(links[0].id, '7621611');
});

test('findVoeLinks falls back to data-id and reports every voe row', () => {
  const html = episodePage([
    hostingRow('voe.sx', { id: '1' }),
    hostingRow('voe.sx', { id: '2' }),
  ]);
  assert.deepEqual(findVoeLinks(html).map((link) => link.id), ['1', '2']);
});

test('findVoeLinks surfaces the data-mp4 branch the page plays directly', () => {
  const encoded = Buffer.from(PLAYER, 'utf8').toString('base64');
  const [link] = findVoeLinks(
    episodePage([hostingRow('voe.sx', { id: '9', mp4: '1', href: encoded })]),
  );
  assert.equal(link.mp4, '1');
  assert.equal(decodePlayerUrl(link.href), PLAYER);
});

test('findVoeLinks yields nothing when no hosting is listed', () => {
  assert.deepEqual(findVoeLinks(episodePage([])), []);
  assert.deepEqual(findVoeLinks('<a href="/premium">Odtwarzacz bez limitów</a>'), []);
});

test('findRouteToken reads the per-page-load token', () => {
  assert.equal(findRouteToken(episodePage([], { routeToken: 'deadbeef' })), 'deadbeef');
  assert.equal(findRouteToken('<script>var x = 1;</script>'), null);
});

test('decodePlayerUrl decodes what the token endpoint returns', () => {
  assert.equal(decodePlayerUrl(Buffer.from(PLAYER, 'utf8').toString('base64')), PLAYER);
});

test('decodePlayerUrl rejects a body that does not decode to a URL', () => {
  assert.throws(
    () => decodePlayerUrl(Buffer.from('Nieaktualny endpoint', 'utf8').toString('base64')),
    /not a URL/,
  );
});

test('parseSelection expands numbers, ranges and "all"', () => {
  assert.deepEqual(parseSelection('1,3,5-8', 10), [1, 3, 5, 6, 7, 8]);
  assert.deepEqual(parseSelection('all', 3), [1, 2, 3]);
  assert.deepEqual(parseSelection('*', 2), [1, 2]);
  assert.deepEqual(parseSelection('1 3', 3), [1, 3], 'spaces separate too');
});

test('parseSelection sorts and de-duplicates overlapping picks', () => {
  assert.deepEqual(parseSelection('5,1,2-4,3', 10), [1, 2, 3, 4, 5]);
});

test('parseSelection accepts a reversed range', () => {
  assert.deepEqual(parseSelection('8-5', 10), [5, 6, 7, 8]);
});

test('parseSelection rejects blank and out-of-bounds input', () => {
  assert.equal(parseSelection('', 10), null);
  assert.equal(parseSelection('   ', 10), null);
  assert.equal(parseSelection(undefined, 10), null);
  assert.equal(parseSelection('0', 10), null, 'the listing is 1-based');
  assert.equal(parseSelection('11', 10), null);
  assert.equal(parseSelection('1-11', 10), null);
  assert.equal(parseSelection('abc', 10), null);
  assert.equal(parseSelection('1,,x', 10), null);
});

/**
 * Stand in for `fetch` for the duration of `body`, recording every call.
 *
 * `requestEmbedUrl` goes through `src/http.js`, whose retry loop is the point
 * of these tests, so the seam has to be the global rather than the module.
 */
async function withFetch(responses, body) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const { status = 200, payload } = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const TOO_FAST = { status: 429, payload: { ok: false, error: 'Za szybko, spróbuj za chwilę' } };

test('isRateLimited recognises both shapes of "slow down"', () => {
  assert.equal(isRateLimited(new Error('HTTP 429 Too Many Requests for https://filman.cc/')), true);
  assert.equal(isRateLimited(new Error('… (HTTP 429: Za szybko, spróbuj za chwilę)')), true);
  assert.equal(isRateLimited(Object.assign(new Error('nope'), { rateLimited: true })), true);
  assert.equal(isRateLimited(new Error('no voe.sx hosting is listed')), false);
  assert.equal(isRateLimited(null), false);
});

test('a rate-limited token call is not retried without the route token', async () => {
  await withFetch([TOO_FAST], async (calls) => {
    // `retries: 0` keeps the http-level backoff out of the test's runtime; the
    // behaviour under test is the token-less *second* call, which must not fire.
    await assert.rejects(
      () => requestEmbedUrl('123', { routeToken: 'deadbeef', retries: 0 }),
      (error) => error.rateLimited === true && /Za szybko/.test(error.message),
    );
    assert.equal(calls.length, 1, 'a rate limit is not a rejected token');
  });
});

test('a rejected route token is still retried without it', async () => {
  const responses = [
    { status: 403, payload: { ok: false, error: 'Nieaktualny endpoint' } },
    { status: 200, payload: { ok: true, url: Buffer.from(PLAYER, 'utf8').toString('base64') } },
  ];
  await withFetch(responses, async (calls) => {
    assert.equal(await requestEmbedUrl('123', { routeToken: 'stale', retries: 0 }), PLAYER);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /[?&]rt=stale\b/);
    assert.doesNotMatch(calls[1].url, /[?&]rt=/, 'the second call drops the token');
  });
});

test('formatSelection writes the shortest spelling of a selection', () => {
  assert.equal(formatSelection([13, 14, 15, 17]), '13-15,17');
  assert.equal(formatSelection([1]), '1');
  assert.equal(formatSelection([5, 6]), '5,6', 'a pair is no shorter as a range');
  assert.equal(formatSelection([3, 2, 1]), '1-3', 'unsorted input still collapses');
  assert.equal(formatSelection([4, 4, 5, 6]), '4-6', 'duplicates fold away');
  assert.equal(formatSelection([]), '');
});

test('formatSelection round-trips through parseSelection', () => {
  for (const picked of [[1], [2, 4, 6], [13, 14, 15, 17], [1, 2, 3, 4, 5]]) {
    assert.deepEqual(parseSelection(formatSelection(picked), 20), picked);
  }
});

/** Silence the CLI's stdout/stderr chatter for the duration of `body`. */
async function quietly(body) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await body();
  } finally {
    Object.assign(console, { log, error });
  }
}

const season = (count) => ({
  number: 11,
  episodes: Array.from({ length: count }, (_, i) => ({
    season: 11,
    episode: i + 1,
    label: `s11e${String(i + 1).padStart(2, '0')}`,
    title: `Episode ${i + 1}`,
    url: `https://filman.cc/e/${i + 1}`,
  })),
});

const tooFast = () =>
  Object.assign(new Error('the site refused (HTTP 429: Za szybko)'), { rateLimited: true });

test('collectLinks stops the run once the site blocks us twice in a row', async () => {
  const s = season(6);
  // Episodes 3 and 4 are refused; the run must not go on to 5 and 6.
  const attempted = [];
  const resolve = async (url) => {
    attempted.push(url);
    if (attempted.length >= 3) throw tooFast();
    return `https://embed.example/${attempted.length}`;
  };

  const result = await quietly(() =>
    collectLinks(s.episodes, { delay: 0, cooldowns: [], resolve }),
  );

  assert.equal(result.blocked, true);
  assert.equal(result.links.length, 2, 'the links collected before the block are kept');
  assert.equal(result.failures, 2);
  assert.equal(attempted.length, 4, 'episodes 5 and 6 are never attempted');
  assert.deepEqual(
    result.remaining.map((episode) => episode.episode),
    [3, 4, 5, 6],
    'the block starts at episode 3, so that is where a resume picks up',
  );
});

test('collectLinks treats an isolated refusal as back-pressure, not a block', async () => {
  const s = season(4);
  let calls = 0;
  const resolve = async () => {
    calls++;
    if (calls === 2) throw tooFast(); // one bad episode between three good ones
    return `https://embed.example/${calls}`;
  };

  const result = await quietly(() => collectLinks(s.episodes, { delay: 0, cooldowns: [], resolve }));

  assert.equal(result.blocked, false, 'a success in between resets the count');
  assert.equal(result.links.length, 3);
  assert.equal(result.failures, 1);
});

test('collectLinks does not count ordinary failures towards the block limit', async () => {
  const s = season(3);
  const resolve = async () => {
    throw new Error('no voe.sx hosting is listed for this episode');
  };

  const result = await quietly(() => collectLinks(s.episodes, { delay: 0, cooldowns: [], resolve }));

  assert.equal(result.blocked, false);
  assert.equal(result.failures, 3, 'every episode is still attempted');
});

test('collectLinks hands each link to onLink as it resolves', async () => {
  const s = season(3);
  const written = [];
  const resolve = async (url) => `https://embed.example/${url.split('/').pop()}`;

  await quietly(() =>
    collectLinks(s.episodes, {
      delay: 0,
      cooldowns: [],
      resolve,
      onLink: ({ episode }) => void written.push(episode.label),
    }),
  );

  assert.deepEqual(written, ['s11e01', 's11e02', 's11e03']);
});

test('formatResumeCommand numbers episodes by their place in the season', () => {
  const s = season(20);
  const remaining = [s.episodes[12], s.episodes[13], s.episodes[14], s.episodes[16]];

  assert.equal(
    formatResumeCommand(remaining, s, 'https://filman.cc/s/673/x'),
    'filman-dl --season 11 --episodes 13-15,17 https://filman.cc/s/673/x',
  );
  assert.equal(formatResumeCommand([], s, 'https://filman.cc/s/673/x'), null);
});
