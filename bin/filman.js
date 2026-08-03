#!/usr/bin/env node
/**
 * CLI for collecting VOE embed links from a filman.cc series page.
 *
 * Pick a season, pick episodes, get one URL per line on stdout. Everything
 * else — prompts, progress, errors — goes to stderr, so the output stays
 * pipeable into voe-dl and clean when redirected to a file. The --out file is
 * the exception: it labels each link with its episode, since it is meant to be
 * read later rather than piped.
 */

import { appendFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { fetchSeasons, resolveEpisode, isRateLimited, FILMAN_ORIGIN } from '../src/filman.js';
import { setCookies, setUserAgent } from '../src/http.js';
import { createAsker, parseSelection, formatSelection } from '../src/prompt.js';

const VERSION = '1.0.0';

const USAGE = `filman-dl ${VERSION} — collect VOE links from a filman.cc series

Usage:
  filman-dl <series-url>        pick a season and episodes, print their links
  filman-dl                     prompt for the series URL as well

filman.cc sits behind Cloudflare. It often serves these pages unchallenged, so
try it without credentials first; if you are challenged, copy the cookies from
a browser (DevTools → Network → any request → Cookie) along with that browser's
User-Agent — cf_clearance is only valid for the UA that earned it.

Options:
  -o, --out <file>         also write the links to a file, one labelled
                           [sNNeMM] Title, <url> per line
      --cookie <string>    filman.cc cookies      (or set FILMAN_COOKIE)
      --user-agent <ua>    matching User-Agent    (or set FILMAN_UA)
      --season <n>         answer the season prompt up front
      --episodes <spec>    answer the episode prompt up front (1,3,5-8 | all)
      --delay <ms>         pause between episodes (default: 1500)
      --debug              print stack traces on failure
  -h, --help               show this help
  -v, --version            show the version

Examples:
  export FILMAN_COOKIE='PHPSESSID=…; cf_clearance=…'
  export FILMAN_UA='Mozilla/5.0 (Macintosh; …) Chrome/148.0.0.0 Safari/537.36'

  filman-dl https://filman.cc/s/673/simpsonowie-the-simpsons
  filman-dl --season 11 --episodes 1,3,5-8 https://filman.cc/s/673/… > links.txt
  filman-dl --season 11 --episodes all https://filman.cc/s/673/… | xargs voe-dl
`;

function parseCliArgs(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      cookie: { type: 'string' },
      'user-agent': { type: 'string' },
      season: { type: 'string' },
      episodes: { type: 'string' },
      // 400ms cleared a handful of episodes and then ran into the site's
      // limiter; 1.5s is slow enough to get through a season in one go.
      delay: { type: 'string', default: '1500' },
      debug: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isSeriesUrl = (value) => /^https?:\/\//i.test(value) && URL.canParse(value);

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Season numbers, wrapped so a long run of seasons stays readable. */
function formatSeasons(seasons) {
  return seasons
    .map((season) => `${season.number} (${season.episodes.length})`)
    .reduce((lines, entry, index) => {
      if (index % 6 === 0) lines.push([]);
      lines.at(-1).push(entry.padEnd(9));
      return lines;
    }, [])
    .map((line) => `    ${line.join('').trimEnd()}`)
    .join('\n');
}

function formatEpisodes(episodes) {
  const width = String(episodes.length).length;
  return episodes
    .map((ep, i) => `  ${String(i + 1).padStart(width)}) [${ep.label}] ${ep.title}`)
    .join('\n');
}

/** The --out file, unlike stdout, is for reading later — so label each link. */
function formatLink({ episode, url }) {
  return `[${episode.label}] ${episode.title}, ${url}\n`;
}

/** Resolve the season to work on, from --season or the prompt. */
async function chooseSeason(seasons, { preset, ask }) {
  const find = (value) => seasons.find((season) => season.number === Number(value));

  if (preset !== undefined) {
    const season = find(preset);
    if (!season) throw new Error(`no season ${preset} on this page`);
    return season;
  }

  console.error(`\nSeasons (episode counts in brackets):\n${formatSeasons(seasons)}`);
  for (;;) {
    const answer = await ask('\nSeason> ');
    if (answer === null) return null;
    if (!answer) continue;
    const season = find(answer);
    if (season) return season;
    console.error('  no such season');
  }
}

/** Resolve the episodes to collect, from --episodes or the prompt. */
async function chooseEpisodes(season, { preset, ask }) {
  const { episodes } = season;

  if (preset !== undefined) {
    const picked = parseSelection(preset, episodes.length);
    if (!picked) throw new Error(`--episodes "${preset}" is not a valid selection`);
    return picked.map((index) => episodes[index - 1]);
  }

  console.error(
    `\nSeason ${season.number} — ${episodes.length} episodes\n${formatEpisodes(episodes)}`,
  );
  for (;;) {
    const answer = await ask('\nEpisodes (e.g. 1,3,5-8 or all)> ');
    if (answer === null) return null;
    const picked = parseSelection(answer, episodes.length);
    if (picked) return picked.map((index) => episodes[index - 1]);
    console.error(`  enter numbers or ranges between 1 and ${episodes.length}, or "all"`);
  }
}

/**
 * How long to sit out a rate limit, per consecutive refusal on one episode.
 *
 * The site's own message is "spróbuj za chwilę" — try in a moment — so the
 * first wait is short. The ladder stops at half a minute deliberately: a
 * refusal that survives it is not a moment's back-pressure but the block
 * described at BLOCK_LIMIT, which no ladder this side of ten minutes outlasts.
 */
const COOLDOWNS = [10_000, 30_000];

/** The pause between episodes never grows past this, however often we are told off. */
const MAX_PACE = 10_000;

/**
 * How many episodes may be lost to the limiter in a row before the run stops.
 *
 * Observed behaviour is that filman.cc blocks for around ten minutes at a
 * stretch. Once that starts, every remaining episode is going to spend the full
 * cooldown ladder and fail anyway, so continuing turns a season into half an
 * hour of certain failures. Two in a row tells the difference between one
 * unlucky episode and a block, and the caller gets what is left so the run can
 * be resumed once the block clears.
 */
const BLOCK_LIMIT = 2;

/**
 * Visit each episode in turn and print the link it yields. One failure does not
 * end the run; the count comes back so the exit code can reflect it.
 *
 * Rate limiting is treated as back-pressure rather than failure: a refused
 * episode is waited out and retried, and every refusal also slows the pace for
 * the episodes that follow. Asking a whole season's worth of links back to back
 * is what trips the limiter in the first place, so a run that has already been
 * told off once does not go back to full speed.
 *
 * `onLink` is awaited for each resolved episode, so a link is durable before
 * the next one is attempted rather than only once the whole run survives.
 *
 * `resolve` and `cooldowns` are injectable so the pacing policy can be tested
 * without a network or a minute of real waiting; the CLI always takes both
 * defaults.
 */
export async function collectLinks(
  episodes,
  { delay, debug, onLink, resolve = resolveEpisode, cooldowns = COOLDOWNS },
) {
  const links = [];
  let failures = 0;
  let pace = delay;
  let blocks = 0;

  for (const [index, episode] of episodes.entries()) {
    const position = `[${index + 1}/${episodes.length}]`;
    console.error(`${position} [${episode.label}] ${episode.title}`);

    for (let cooldown = 0; ; ) {
      try {
        const url = await resolve(episode.url, {
          referer: FILMAN_ORIGIN,
          clickDelay: Math.min(delay / 2, 1000),
        });
        console.log(url); // stdout: the one thing worth piping
        links.push({ episode, url });
        await onLink?.({ episode, url });
        blocks = 0; // the site is answering again
        break;
      } catch (error) {
        const limited = isRateLimited(error);
        if (limited && cooldown < cooldowns.length) {
          const wait = cooldowns[cooldown++];
          pace = Math.min(Math.max(pace * 2, 1000), MAX_PACE);
          console.error(`  rate limited; waiting ${Math.round(wait / 1000)}s before retrying`);
          await sleep(wait);
          continue;
        }
        failures++;
        if (limited) blocks++;
        console.error(`  skipped: ${error.message}`);
        if (debug) console.error(error.stack);
        break;
      }
    }

    if (blocks >= BLOCK_LIMIT) {
      return { links, failures, blocked: true, remaining: episodes.slice(index + 1 - blocks) };
    }

    // Jitter keeps the calls from arriving on a metronome, which is both what a
    // person does not look like and the easiest pattern for a limiter to catch.
    if (pace > 0 && index < episodes.length - 1) await sleep(pace + Math.random() * pace * 0.3);
  }

  return { links, failures, blocked: false, remaining: [] };
}

/**
 * The command that would pick up where a blocked run left off.
 *
 * `--episodes` numbers are positions in the season's own list rather than in
 * the selection, so they are recovered from the season instead of the slice —
 * `chooseEpisodes` hands back the very objects the season holds.
 */
export function formatResumeCommand(remaining, season, seriesUrl) {
  const positions = remaining
    .map((episode) => season.episodes.indexOf(episode) + 1)
    .filter((position) => position > 0);
  if (positions.length === 0) return null;

  return (
    `filman-dl --season ${season.number} ` +
    `--episodes ${formatSelection(positions)} ${seriesUrl}`
  );
}

async function main() {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`filman-dl: ${error.message}\n`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const { values, positionals } = parsed;
  if (values.help) return void console.log(USAGE);
  if (values.version) return void console.log(VERSION);

  const delay = Number.parseInt(values.delay, 10);
  if (!Number.isInteger(delay) || delay < 0 || delay > 60_000) {
    console.error('filman-dl: --delay must be a whole number of milliseconds, 0–60000');
    process.exitCode = 2;
    return;
  }

  // Cookies are not always needed — filman.cc serves these pages unchallenged
  // much of the time — so a missing one is a warning, not a refusal to run.
  const cookie = values.cookie ?? process.env.FILMAN_COOKIE;
  if (cookie) setCookies(cookie, 'filman.cc');

  const userAgent = values['user-agent'] ?? process.env.FILMAN_UA;
  if (userAgent) setUserAgent(userAgent);
  else if (cookie) {
    console.error(
      'filman-dl: no --user-agent / FILMAN_UA given; Cloudflare binds cf_clearance\n' +
        '           to the browser that earned it, so the cookie may be rejected.',
    );
  }

  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  const ask = createAsker(rl);

  try {
    let seriesUrl = positionals[0];
    while (!seriesUrl) {
      const answer = await ask('Series URL> ');
      if (answer === null) return;
      if (answer && isSeriesUrl(answer)) seriesUrl = answer;
      else if (answer) console.error('  that does not look like a URL');
    }
    if (!isSeriesUrl(seriesUrl)) {
      console.error(`filman-dl: ${seriesUrl} is not a URL`);
      process.exitCode = 2;
      return;
    }

    console.error(`Fetching ${seriesUrl}`);
    const seasons = await fetchSeasons(seriesUrl);
    console.error(
      `  ${plural(seasons.length, 'season')}, ` +
        `${plural(
          seasons.reduce((sum, season) => sum + season.episodes.length, 0),
          'episode',
        )}`,
    );

    const season = await chooseSeason(seasons, { preset: values.season, ask });
    if (!season) return;
    const episodes = await chooseEpisodes(season, { preset: values.episodes, ask });
    if (!episodes) return;

    // Links are written as they resolve rather than at the end: a run can be
    // interrupted by a block or a Ctrl-C during one of the waits, and the links
    // already paid for should survive that. Truncating up front keeps the file
    // from being a mix of this run and the last.
    if (values.out) await writeFile(values.out, '', 'utf8');
    const onLink = values.out
      ? (link) => appendFile(values.out, formatLink(link), 'utf8')
      : undefined;

    console.error(`\nResolving ${plural(episodes.length, 'episode')}…\n`);
    const { links, failures, blocked, remaining } = await collectLinks(episodes, {
      delay,
      debug: values.debug,
      onLink,
    });

    if (values.out && links.length > 0) {
      console.error(`\nWrote ${plural(links.length, 'link')} to ${values.out}`);
    }

    if (blocked) {
      const resume = formatResumeCommand(remaining, season, seriesUrl);
      console.error(
        `\nfilman-dl: blocked by filman.cc — it usually clears in about 10 minutes.\n` +
          `           ${links.length} of ${episodes.length} episodes collected.` +
          (resume ? `\n\n  ${resume}\n` : '\n'),
      );
    }

    console.error(
      `Done: ${plural(links.length, 'link')}${failures > 0 ? `, ${failures} failed` : ''}.` +
        `\nThese URLs are time-limited — hand them to voe-dl soon.`,
    );
    if (failures > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`filman-dl: ${error.message}`);
    if (values.debug) console.error(error.stack);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

// Only when run as the CLI: the pacing helpers above are imported by the tests,
// which must not start a session of their own.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`filman-dl: unexpected error: ${error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  });
}
