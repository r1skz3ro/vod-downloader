/**
 * Turning an HLS manifest into a file on disk is split in two, and the split
 * is deliberate:
 *
 *  1. fetching is ours. Every segment goes through `http.js`, so it carries the
 *     same Referer/Origin/Sec-Fetch shape and DDoS-Guard cookies that won us
 *     the manifest, and retries when a delivery node hiccups. Handing the
 *     manifest to ffmpeg instead makes it fetch segments with a single static
 *     `-headers` blob, which VOE's CDN answers with 403s partway through.
 *  2. muxing is ffmpeg's, on a local file, with no network involved.
 *
 * Both stages are stream copies. The video and audio bitstreams are never
 * re-encoded, so the output is bit-for-bit the media the player received.
 * `downloadWithFfmpeg` remains for `--ffmpeg`, when the CDN is friendly and a
 * one-pass download is worth it.
 */

import { spawn } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { once } from 'node:events';

import { cookieHeaderFor, getBuffer, getText, USER_AGENT } from './http.js';
import { parseMediaPlaylist } from './hls.js';

/** Resolve to true when an `ffmpeg` binary is on PATH. */
export function hasFfmpeg() {
  return new Promise((resolve) => {
    const probe = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}

/** Header block ffmpeg expects: CRLF-separated `Name: value` lines. */
function ffmpegHeaders(url, referer) {
  const lines = [`User-Agent: ${USER_AGENT}`];
  if (referer) {
    lines.push(`Referer: ${referer}`, `Origin: ${new URL(referer).origin}`);
  }
  const cookie = cookieHeaderFor(url);
  if (cookie) lines.push(`Cookie: ${cookie}`);
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Remux the stream to MP4 with ffmpeg, leaving its progress output on stderr
 * so a multi-gigabyte download is not a silent wait.
 */
export async function downloadWithFfmpeg(streamUrl, outputPath, { referer } = {}) {
  const partPath = `${outputPath}.part`;
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-headers', ffmpegHeaders(streamUrl, referer),
    '-i', streamUrl,
    '-c', 'copy',
    // AAC carried in MPEG-TS needs its ADTS headers rewritten for MP4.
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    // We write to a ".part" file, so ffmpeg cannot infer the container from
    // the extension and must be told explicitly.
    '-f', 'mp4',
    '-y',
    partPath,
  ];

  const code = await new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', () => resolve(-1));
    child.on('close', resolve);
  });

  if (code !== 0) {
    await unlink(partPath).catch(() => {});
    throw new Error(`ffmpeg exited with code ${code}`);
  }
  await rename(partPath, outputPath);
  return outputPath;
}

/** Fetch and cache the AES-128 key for a segment, if it has one. */
async function resolveKey(key, cache, referer) {
  if (!key?.uri) return null;
  if (key.method !== 'AES-128') {
    throw new Error(`unsupported HLS encryption method: ${key.method}`);
  }
  if (!cache.has(key.uri)) {
    cache.set(key.uri, await getBuffer(key.uri, { referer }));
  }
  return cache.get(key.uri);
}

/** IV from the playlist, else the segment's media sequence number, big-endian. */
function resolveIv(key, index) {
  if (key?.iv) {
    return Buffer.from(key.iv.replace(/^0x/i, ''), 'hex');
  }
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(index >>> 0, 12);
  return iv;
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Pure-Node fallback: pull the media playlist, fetch segments through a
 * bounded concurrency window, decrypt if needed, and append them in playlist
 * order. Writes MPEG-TS, which every serious player handles.
 */
export async function downloadWithNode(streamUrl, outputPath, options = {}) {
  const { referer, concurrency = 8, onProgress } = options;

  const { text, url: resolvedUrl } = await getText(streamUrl, { referer });
  const { segments, totalDuration } = parseMediaPlaylist(text, resolvedUrl);
  if (segments.length === 0) {
    throw new Error('media playlist contained no segments');
  }

  const partPath = `${outputPath}.part`;
  const out = createWriteStream(partPath);
  const keyCache = new Map();
  const started = Date.now();
  let bytes = 0;

  const fetchSegment = async (segment) => {
    const data = await getBuffer(segment.url, { referer });
    const keyBytes = await resolveKey(segment.key, keyCache, referer);
    if (!keyBytes) return data;
    const decipher = createDecipheriv('aes-128-cbc', keyBytes, resolveIv(segment.key, segment.index));
    return Buffer.concat([decipher.update(data), decipher.final()]);
  };

  /**
   * Start a segment, marking its promise as handled straight away.
   *
   * Segments are awaited in playlist order, so a failure in one that is not
   * the one currently being awaited would sit unhandled for as long as the
   * segments ahead of it take — and Node turns an unhandled rejection into an
   * uncaught exception, killing the download instead of failing it. The
   * rejection is still delivered to whoever awaits the promise later.
   */
  const start = (index) => {
    const promise = fetchSegment(segments[index]);
    promise.catch(() => {});
    return promise;
  };

  const inFlight = new Map();

  try {
    let nextToStart = 0;

    for (let i = 0; i < segments.length; i++) {
      // Keep the window full so downloads overlap, but write strictly in order.
      while (inFlight.size < concurrency && nextToStart < segments.length) {
        inFlight.set(nextToStart, start(nextToStart));
        nextToStart++;
      }

      const chunk = await inFlight.get(i);
      inFlight.delete(i);
      bytes += chunk.length;

      if (!out.write(chunk)) await once(out, 'drain');
      onProgress?.({
        completed: i + 1,
        total: segments.length,
        bytes,
        elapsed: (Date.now() - started) / 1000,
        totalDuration,
      });
    }

    out.end();
    await once(out, 'finish');
  } catch (error) {
    // Let the rest of the window settle before unwinding. Abandoning the
    // promises here would leave the ones that fail later with nowhere to go.
    await Promise.allSettled(inFlight.values());
    out.destroy();
    await unlink(partPath).catch(() => {});
    throw error;
  }

  await rename(partPath, outputPath);
  return outputPath;
}

/** ANSI "erase to end of line", so a shorter line never leaves stale text behind. */
const CLEAR_LINE = String.fromCharCode(27) + '[K';

/** Single-line progress reporter for the Node downloader. */
export function makeProgressReporter(stream = process.stderr) {
  const isTty = stream.isTTY;
  let lastPrint = 0;

  return ({ completed, total, bytes, elapsed }) => {
    const done = completed === total;
    const now = Date.now();
    if (!done && now - lastPrint < 200) return;
    lastPrint = now;

    const pct = Math.round((completed / total) * 100);
    const filled = Math.round((completed / total) * 24);
    const bar = '#'.repeat(filled).padEnd(24, '-');
    const rate = elapsed > 0 ? `${formatBytes(bytes / elapsed)}/s` : '—';
    const line = `  [${bar}] ${String(pct).padStart(3)}%  ${completed}/${total} segments  ${formatBytes(bytes)}  ${rate}`;

    if (isTty) {
      stream.write(`\r${line}${CLEAR_LINE}`);
      if (done) stream.write('\n');
    } else if (done) {
      stream.write(`${line}\n`);
    }
  };
}

/**
 * Download `streamUrl` to `outputPath`: fetch the segments ourselves, then
 * remux the result to MP4 with ffmpeg when it is available. Returns the path
 * actually written, which is `.ts` instead of `.mp4` when there is no ffmpeg
 * to remux with.
 *
 * `onProgress` replaces the built-in single-line reporter, for callers that
 * render progress themselves — several downloads at once cannot each own the
 * cursor. `quiet` silences the engine notes either way.
 */
export async function download(streamUrl, outputPath, options = {}) {
  const {
    referer, concurrency, forceNode = false, useFfmpeg = false, quiet = false, onProgress,
  } = options;
  const log = quiet ? () => {} : (msg) => console.error(msg);

  const ffmpegAvailable = forceNode ? false : await hasFfmpeg();

  // Opt-in one-pass download. Kept behind a flag because VOE's delivery nodes
  // reject ffmpeg's segment requests often enough that it is not a sane default.
  if (ffmpegAvailable && useFfmpeg) {
    try {
      log('  engine: ffmpeg (--ffmpeg; stream copy, no re-encode)');
      return await downloadWithFfmpeg(streamUrl, outputPath, { referer });
    } catch (error) {
      log(`  ffmpeg failed (${error.message}); falling back to the built-in downloader`);
    }
  } else if (forceNode) {
    log('  engine: built-in downloader (--force-node)');
  } else if (ffmpegAvailable) {
    log('  engine: built-in downloader (stream copy), ffmpeg remux to MP4');
  } else {
    log('  engine: built-in downloader; ffmpeg not found, output will be MPEG-TS');
  }

  const tsPath = outputPath.replace(/\.mp4$/i, '.ts');
  await downloadWithNode(streamUrl, tsPath, {
    referer,
    concurrency,
    onProgress: onProgress ?? (quiet ? undefined : makeProgressReporter()),
  });

  if (ffmpegAvailable && tsPath !== outputPath) {
    try {
      await remuxLocal(tsPath, outputPath, { quiet });
      await unlink(tsPath).catch(() => {});
      return outputPath;
    } catch {
      // ffmpeg creates the output file before it discovers it cannot write it,
      // so a failed remux leaves an empty MP4 next to the good MPEG-TS. Clear
      // it out: it plays back as nothing, and callers that treat an existing
      // file as "already downloaded" would trust it.
      await unlink(outputPath).catch(() => {});
      log('  could not remux to MP4; leaving the MPEG-TS file in place');
    }
  }
  return tsPath;
}

/**
 * Remux an already-downloaded local file to MP4 without re-encoding.
 *
 * `quiet` swallows ffmpeg's stderr, for callers that are drawing their own
 * output and cannot have a subprocess writing over it.
 */
async function remuxLocal(inputPath, outputPath, { quiet = false } = {}) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    '-y', outputPath,
  ];
  const code = await new Promise((resolve) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', quiet ? 'ignore' : 'inherit'],
    });
    child.on('error', () => resolve(-1));
    child.on('close', resolve);
  });
  if (code !== 0) throw new Error(`ffmpeg remux exited with code ${code}`);
}
