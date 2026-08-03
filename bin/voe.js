#!/usr/bin/env node
/**
 * CLI entry point. Three modes:
 *   voe-dl <url> [...]   one-shot, scriptable
 *   voe-dl -f <file>     batch: every episode in a filman-dl link file
 *   voe-dl               interactive prompt loop
 */

import { access, mkdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { resolveEmbedUrl } from "../src/embed.js";
import { extractVideo, sanitiseFilename } from "../src/extract.js";
import { clearCookies, getText } from "../src/http.js";
import {
  formatVariantTable,
  isMasterPlaylist,
  parseMasterPlaylist,
  selectVariant,
} from "../src/hls.js";
import { download } from "../src/download.js";
import { createDashboard } from "../src/dashboard.js";
import { parseLinkFile, seasonOf, seasonsIn } from "../src/linkfile.js";
import { runPool } from "../src/pool.js";
import { createAsker } from "../src/prompt.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const VERSION = "1.0.0";

const USAGE = `voe-dl ${VERSION} — download videos from voe.sx

Usage:
  voe-dl <url> [<url> ...]      download one or more videos
  voe-dl -f <file>              download every episode in a link file
  voe-dl                        start the interactive prompt

A URL may be a VOE link or an embed page that frames one; embed pages are
resolved to the underlying VOE URL automatically.

A link file is what filman-dl writes: one episode per line, its label and then
its URL, e.g. "[s06e04] Kraina Zdrapka i Poharatki, https://embed.example/...".
The label becomes the filename and the season tag the folder, so the episodes
land in "<show> season 06" next to this repo.

Options:
  -u, --url-only          print the resolved stream URL and exit
  -F, --list-formats      list the available qualities and exit
  -f, --file <path>       download every episode listed in a link file
  -j, --jobs <n>          episodes downloaded at once, with --file (default: 4)
      --show <name>       series name for the output folder (default: The Simpsons)
      --force             re-download episodes that are already on disk
  -q, --quality <q>       best (default) | worst | a height such as 720
  -o, --output <dir>      output directory (default: ./downloads, or the season
                          folder with --file)
  -n, --name <name>       output filename, without extension
  -c, --concurrency <n>   parallel segment fetches (default: 8)
      --ffmpeg            let ffmpeg fetch the stream itself; faster when the
                          CDN allows it, but VOE often answers it with 403s
      --force-node        never call ffmpeg, not even to remux (leaves .ts)
      --debug             print the deobfuscation trace and extra diagnostics
  -h, --help              show this help
  -v, --version           show the version

Examples:
  voe-dl https://voe.sx/e/xxxxxxxxxxxx
  voe-dl https://embed.example.com/1234/5678/abcdef/
  voe-dl -q 720 -o ~/Videos https://voe.sx/e/xxxxxxxxxxxx
  voe-dl -f links.txt
  voe-dl -f links.txt --show Futurama -j 2
  voe-dl --url-only https://voe.sx/e/xxxxxxxxxxxx | xargs mpv
`;

function parseCliArgs(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "url-only": { type: "boolean", short: "u", default: false },
      "list-formats": { type: "boolean", short: "F", default: false },
      file: { type: "string", short: "f" },
      jobs: { type: "string", short: "j", default: "4" },
      show: { type: "string", default: "The.Simpsons" },
      force: { type: "boolean", default: false },
      quality: { type: "string", short: "q" },
      output: { type: "string", short: "o" },
      name: { type: "string", short: "n" },
      concurrency: { type: "string", short: "c", default: "8" },
      ffmpeg: { type: "boolean", default: false },
      "force-node": { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
}

/**
 * Resolve a master playlist down to the chosen variant. A media playlist (or
 * anything that is not HLS) passes straight through.
 */
async function resolveQuality(
  streamUrl,
  { referer, quality, listFormats, debug },
) {
  if (!/\.m3u8(\?|#|$)/i.test(streamUrl)) {
    if (listFormats) console.log("  (not an HLS stream; no quality variants)");
    return { url: streamUrl, variants: [], chosen: null };
  }

  let text;
  let resolvedUrl = streamUrl;
  try {
    const response = await getText(streamUrl, { referer });
    text = response.text;
    resolvedUrl = response.url;
  } catch (error) {
    if (debug)
      console.error(
        `  could not read the manifest (${error.message}); using it as-is`,
      );
    return { url: streamUrl, variants: [], chosen: null };
  }

  if (!isMasterPlaylist(text)) {
    return { url: resolvedUrl, variants: [], chosen: null };
  }

  const variants = parseMasterPlaylist(text, resolvedUrl);
  const chosen = selectVariant(variants, quality);
  return { url: chosen?.url ?? resolvedUrl, variants, chosen };
}

/**
 * URL in, playable stream out: resolve the embed wrapper, extract the video,
 * then pick the quality variant. Shared by the single-URL path and the batch
 * one, which differ only in what they print along the way.
 */
async function resolveStream(url, opts, { onNote } = {}) {
  const { quality, listFormats, debug } = opts;
  const note = onNote ?? (() => {});

  // Embed wrappers frame the real player rather than hosting it; a VOE URL
  // comes back unchanged, without a request.
  const target = await resolveEmbedUrl(url, { debug });
  if (target !== url) note(`  embed:    ${target}`);

  const info = await extractVideo(target, {
    debug,
    referer: target !== url ? url : undefined,
  });
  note(`  title:    ${info.title}`);
  note(`  strategy: ${info.strategy}`);
  if (debug && info.candidates.length > 1) {
    note(`  other candidates:\n    ${info.candidates.slice(1).join("\n    ")}`);
  }

  const {
    url: streamUrl,
    variants,
    chosen,
  } = await resolveQuality(info.streamUrl, {
    referer: info.pageUrl,
    quality,
    listFormats,
    debug,
  });

  return { info, streamUrl, variants, chosen };
}

async function handleUrl(url, opts) {
  const {
    urlOnly,
    listFormats,
    outputDir,
    name,
    concurrency,
    forceNode,
    useFfmpeg,
    debug,
  } = opts;

  if (!urlOnly) console.error(`\nFetching ${url}`);

  const { info, streamUrl, variants, chosen } = await resolveStream(url, opts, {
    onNote: urlOnly ? undefined : (line) => console.error(line),
  });

  if (listFormats) {
    console.log(`${info.title}`);
    console.log(formatVariantTable(variants));
    return true;
  }

  if (urlOnly) {
    console.log(streamUrl);
    return true;
  }

  console.error(`  stream:   ${streamUrl}`);
  if (chosen)
    console.error(
      `  quality:  ${chosen.label} (${chosen.width}x${chosen.height})`,
    );

  await mkdir(outputDir, { recursive: true });
  const base = name || info.title;
  const outputPath = path.resolve(outputDir, `${base}.mp4`);
  console.error(`  output:   ${outputPath}`);

  const written = await download(streamUrl, outputPath, {
    referer: info.pageUrl,
    concurrency,
    forceNode,
    useFfmpeg,
  });
  console.error(`\nDone: ${written}`);
  return true;
}

/** True when `file` is already on disk. */
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a link file's episodes go: "<show> season 06", at the repo root unless
 * the caller named an output directory, in which case it nests inside that.
 */
function seasonDir(entries, opts) {
  const season = seasonOf(entries);
  const folder = sanitiseFilename(
    season ? `${opts.show}.${season}` : opts.show,
  );
  return path.resolve(opts.outputDir ?? REPO_ROOT, folder);
}

/**
 * Download every episode in a link file, `jobs` at a time.
 *
 * Cookies are cleared once here rather than per episode: the jar in `http.js`
 * is process-wide, so clearing it mid-run would pull the DDoS-Guard session out
 * from under the downloads still in flight. Parallel jobs share one session,
 * the way a browser's tabs do.
 */
async function runLinkFile(filePath, opts) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    console.error(`voe-dl: cannot read ${filePath}: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const { entries, errors } = parseLinkFile(text);
  for (const bad of errors) {
    console.error(
      `voe-dl: ${filePath}:${bad.lineNo}: not "<title>, <url>" — skipped`,
    );
  }
  if (entries.length === 0) {
    console.error(`voe-dl: ${filePath} has no episodes`);
    process.exitCode = 2;
    return;
  }

  const seasons = seasonsIn(entries);
  if (seasons.length > 1) {
    console.error(
      `voe-dl: warning: seasons ${seasons.join(", ")} in one file; using ${seasons[0]}`,
    );
  }

  clearCookies();

  // The dry-run flags print, so they keep the ordered single-URL path and the
  // per-episode logging that comes with it.
  if (opts.urlOnly || opts.listFormats) {
    for (const entry of entries) {
      try {
        await handleUrl(entry.url, opts);
      } catch (error) {
        console.error(`voe-dl: ${entry.label}: ${error.message}`);
        process.exitCode = 1;
      }
    }
    return;
  }

  const outputDir = seasonDir(entries, opts);
  await mkdir(outputDir, { recursive: true });
  console.error(`Saving ${entries.length} episode(s) to ${outputDir}`);
  console.error(`Running ${opts.jobs} download(s) at a time.\n`);

  const pending = [];
  const dashboard = createDashboard({
    slots: opts.jobs,
    total: entries.length,
  });

  for (const entry of entries) {
    const base = path.resolve(outputDir, sanitiseFilename(entry.label));
    // A run without ffmpeg leaves MPEG-TS, so that counts as downloaded too.
    const done = (await exists(`${base}.mp4`)) || (await exists(`${base}.ts`));
    if (done && !opts.force) {
      dashboard.skip(entry.label, "already downloaded");
      continue;
    }
    pending.push({ ...entry, outputPath: `${base}.mp4` });
  }

  const results = await runPool(
    pending,
    async (entry, slot) => {
      dashboard.claim(slot, entry.label);
      try {
        const { info, streamUrl } = await resolveStream(entry.url, opts);
        const written = await download(streamUrl, entry.outputPath, {
          referer: info.pageUrl,
          concurrency: opts.concurrency,
          forceNode: opts.forceNode,
          // ffmpeg's own progress output would scribble over the dashboard, so
          // its one-pass mode stays off here; the local remux is quiet.
          useFfmpeg: false,
          quiet: true,
          onProgress: (progress) => dashboard.update(slot, progress),
        });
        dashboard.release(slot, "done", entry.label);
        return written;
      } catch (error) {
        dashboard.release(slot, "fail", entry.label, error.message);
        throw error;
      }
    },
    { limit: opts.jobs },
  );

  dashboard.stop();

  const failed = results.filter((result) => result.status === "rejected");
  const skipped = entries.length - pending.length;
  console.error(
    `\n${pending.length - failed.length} downloaded, ${skipped} skipped, ${failed.length} failed.`,
  );
  for (const { item, reason } of failed) {
    console.error(`  ${item.label}: ${reason.message}`);
    if (opts.debug) console.error(reason.stack);
  }
  if (failed.length > 0) process.exitCode = 1;
}

async function interactiveLoop(opts) {
  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: stdin.isTTY,
  });
  const ask = createAsker(rl, { output: stdout });

  console.log(
    `voe-dl ${VERSION} — interactive mode. Enter a URL, or "quit" to exit.`,
  );

  try {
    for (;;) {
      const answer = await ask("\nVOE URL> ");
      if (answer === null) break; // EOF / Ctrl-D
      if (!answer) continue;
      if (["quit", "exit", "q"].includes(answer.toLowerCase())) break;

      // A non-VOE host is legitimate input now — handleUrl resolves embed
      // wrappers first — so parseability is the only thing left to check.
      // `URL` still has to be guarded: bare "https://" passes the regex.
      if (!/^https?:\/\//i.test(answer) || !URL.canParse(answer)) {
        console.error("  that does not look like a URL");
        continue;
      }

      // Fresh DDoS-Guard cookies per video keeps one bad session from poisoning the next.
      clearCookies();
      try {
        await handleUrl(answer, opts);
      } catch (error) {
        console.error(`  failed: ${error.message}`);
        if (opts.debug) console.error(error.stack);
      }
    }
  } finally {
    rl.close();
  }
  console.log("Bye.");
}

async function main() {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`voe-dl: ${error.message}\n`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const { values, positionals } = parsed;
  if (values.help) return void console.log(USAGE);
  if (values.version) return void console.log(VERSION);

  const concurrency = Number.parseInt(values.concurrency, 10);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    console.error("voe-dl: --concurrency must be an integer between 1 and 32");
    process.exitCode = 2;
    return;
  }

  const jobs = Number.parseInt(values.jobs, 10);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) {
    console.error("voe-dl: --jobs must be an integer between 1 and 8");
    process.exitCode = 2;
    return;
  }

  const opts = {
    urlOnly: values["url-only"],
    listFormats: values["list-formats"],
    quality: values.quality,
    // Left undefined so the batch mode can tell "not given" (its own season
    // folder at the repo root) from an explicit directory to nest inside.
    outputDir: values.output,
    name: values.name,
    concurrency,
    jobs,
    show: values.show,
    force: values.force,
    forceNode: values["force-node"],
    useFfmpeg: values.ffmpeg,
    debug: values.debug,
  };

  if (values.file) {
    if (positionals.length > 0) {
      console.error(
        "voe-dl: --file takes the URLs from the file; drop the ones on the command line",
      );
      process.exitCode = 2;
      return;
    }
    if (values.ffmpeg) {
      console.error(
        "voe-dl: ignoring --ffmpeg; its progress output would fight the batch display",
      );
    }
    await runLinkFile(values.file, opts);
    return;
  }

  opts.outputDir ??= "downloads";

  if (positionals.length === 0) {
    await interactiveLoop(opts);
    return;
  }

  let failures = 0;
  for (const url of positionals) {
    clearCookies();
    try {
      await handleUrl(url, opts);
    } catch (error) {
      failures++;
      console.error(`voe-dl: ${url}: ${error.message}`);
      if (opts.debug) console.error(error.stack);
    }
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`voe-dl: unexpected error: ${error.message}`);
  console.error(error.stack);
  process.exitCode = 1;
});
