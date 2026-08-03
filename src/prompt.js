/**
 * Shared bits of the interactive prompts.
 *
 * `createAsker` exists because `rl.question()` cannot be used here: when stdin
 * is a pipe, readline buffers every line up front and emits them all while a
 * single question is pending, so `question()` silently discards everything
 * after the first line. Driving the line iterator by hand keeps piped input
 * working, which is what makes the prompts scriptable.
 */

/**
 * A `prompt => Promise<string|null>` bound to one readline interface.
 *
 * Prompts are written to stderr so that stdout carries only the machine-
 * readable output, the same split the rest of the CLI observes. Resolves to
 * `null` at EOF (Ctrl-D).
 */
export function createAsker(rl, { output = process.stderr } = {}) {
  const lines = rl[Symbol.asyncIterator]();
  return async (prompt) => {
    output.write(prompt);
    const { value, done } = await lines.next();
    if (done) {
      output.write('\n');
      return null;
    }
    return value.trim();
  };
}

/**
 * Turn a selection such as `1,3,5-8` into 1-based indices, sorted and free of
 * duplicates. `all` (or `*`) selects everything.
 *
 * Returns `null` when the input is blank or malformed, so the caller can tell
 * "nothing chosen" apart from a genuinely empty range and re-prompt.
 *
 * @param {string} input
 * @param {number} max
 * @returns {number[] | null}
 */
export function parseSelection(input, max) {
  const trimmed = input?.trim() ?? '';
  if (!trimmed) return null;
  if (/^(all|\*)$/i.test(trimmed)) {
    return Array.from({ length: max }, (_, i) => i + 1);
  }

  const chosen = new Set();
  // Spaces are accepted as separators too; "1 3 5-8" is the same as "1,3,5-8".
  for (const part of trimmed.split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let [, from, to] = range.map(Number);
      if (from > to) [from, to] = [to, from];
      if (from < 1 || to > max) return null;
      for (let i = from; i <= to; i++) chosen.add(i);
      continue;
    }

    if (!/^\d+$/.test(part)) return null;
    const index = Number(part);
    if (index < 1 || index > max) return null;
    chosen.add(index);
  }

  if (chosen.size === 0) return null;
  return [...chosen].sort((a, b) => a - b);
}

/**
 * The inverse of `parseSelection`: turn 1-based indices back into the shortest
 * `1,3,5-8` spelling of themselves, so a selection can be handed back to the
 * user as a command they can paste.
 *
 * A run of two is written out in full — `5,6` is no longer than `5-6` and reads
 * more plainly.
 *
 * @param {number[]} numbers
 * @returns {string}
 */
export function formatSelection(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);

  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;

    if (end - i >= 2) {
      parts.push(`${sorted[i]}-${sorted[end]}`);
      i = end + 1;
    } else {
      parts.push(String(sorted[i]));
      i++;
    }
  }
  return parts.join(',');
}
