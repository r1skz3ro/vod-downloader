/**
 * Progress for several downloads at once.
 *
 * The single-line reporter in `download.js` owns the cursor: it redraws its bar
 * with a carriage return, which four concurrent downloads would turn into one
 * line of garbage. This renders a fixed block instead — one line per running
 * job plus a tally — and repaints the block in place.
 *
 * Away from a terminal (a pipe, a log file) there is no cursor to move, so the
 * same events come out as one plain line each.
 */

import { formatBytes } from './download.js';

const ESC = String.fromCharCode(27);
const CLEAR_LINE = `${ESC}[K`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

const LABEL_WIDTH = 34;
const BAR_WIDTH = 18;
const REDRAW_MS = 200;

function fitLabel(label) {
  return label.length > LABEL_WIDTH
    ? `${label.slice(0, LABEL_WIDTH - 1)}…`
    : label.padEnd(LABEL_WIDTH);
}

function bar(fraction) {
  const filled = Math.round(fraction * BAR_WIDTH);
  return '#'.repeat(filled).padEnd(BAR_WIDTH, '-');
}

/**
 * @param {{ stream?: NodeJS.WriteStream, slots?: number, total?: number }} options
 */
export function createDashboard({ stream = process.stderr, slots = 4, total = 0 } = {}) {
  const isTty = Boolean(stream.isTTY);
  const jobs = new Array(slots).fill(null);
  const tally = { done: 0, failed: 0, skipped: 0, total };

  let painted = 0;
  let lastPaint = 0;
  let stopped = false;

  const width = () => (stream.columns && stream.columns > 20 ? stream.columns - 1 : 200);

  const jobLine = (job) => {
    if (!job) return '  ' + '·'.repeat(4);
    if (!job.progress) return `  ${fitLabel(job.label)}  resolving…`;

    const { completed, total: segments, bytes, elapsed } = job.progress;
    const fraction = segments > 0 ? completed / segments : 0;
    const rate = elapsed > 0 ? `${formatBytes(bytes / elapsed)}/s` : '—';
    const pct = String(Math.round(fraction * 100)).padStart(3);
    return `  ${fitLabel(job.label)} [${bar(fraction)}] ${pct}%  ${formatBytes(bytes).padStart(8)}  ${rate}`;
  };

  const summary = () => {
    const parts = [`${tally.done}/${tally.total} done`];
    if (tally.skipped) parts.push(`${tally.skipped} skipped`);
    parts.push(`${tally.failed} failed`);
    return `  ${parts.join(', ')}`;
  };

  const paint = (force = false) => {
    if (!isTty || stopped) return;
    const now = Date.now();
    if (!force && now - lastPaint < REDRAW_MS) return;
    lastPaint = now;

    const lines = [...jobs.map(jobLine), summary()].map(
      (line) => line.slice(0, width()) + CLEAR_LINE,
    );
    // Step back over the block drawn last time, then overwrite it. The trailing
    // newline leaves the cursor one line below the block, which is where the
    // next repaint counts back from.
    if (painted > 0) stream.write(`${ESC}[${painted}A`);
    stream.write(`${lines.join('\n')}\n`);
    painted = lines.length;
  };

  const event = (kind, label, detail) => {
    if (isTty) return;
    stream.write(`${kind.padEnd(6)} ${label}${detail ? ` (${detail})` : ''}\n`);
  };

  if (isTty) {
    stream.write(HIDE_CURSOR);
    process.on('exit', () => stream.write(SHOW_CURSOR));
  }

  return {
    /** A job is starting on `slot`; its line is now live. */
    claim(slot, label) {
      jobs[slot] = { label, progress: null };
      event('start', label);
      paint(true);
    },

    /** Segment progress, in the shape `downloadWithNode` reports. */
    update(slot, progress) {
      if (jobs[slot]) jobs[slot].progress = progress;
      paint();
    },

    /** The job on `slot` finished: `status` is 'done' or 'fail'. */
    release(slot, status, label, detail) {
      jobs[slot] = null;
      if (status === 'fail') tally.failed++;
      else tally.done++;
      event(status === 'fail' ? 'fail' : 'done', label, detail);
      paint(true);
    },

    /** An episode that never ran because its file was already on disk. */
    skip(label, detail) {
      tally.skipped++;
      event('skip', label, detail);
      paint(true);
    },

    /**
     * Take the block down and give the cursor back. The caller prints the
     * final tally, so leaving a block of idle slots behind would only repeat
     * it — and in a pipe there was never a block to begin with.
     */
    stop() {
      if (stopped) return;
      if (isTty) {
        if (painted > 0) stream.write(`${ESC}[${painted}A${ESC}[0J`);
        stream.write(SHOW_CURSOR);
      }
      stopped = true;
    },
  };
}
