/**
 * Link files are what `filman-dl` writes: one episode per line, the label it
 * showed in the series listing, then the player URL.
 *
 *   [s06e04] Kraina Zdrapka i Poharatki, https://embed.tmp-url.pro/7363888/.../
 *
 * The label doubles as the filename, so it is kept verbatim — brackets and all.
 */

/**
 * Anchor on the URL rather than on the first comma: labels contain commas
 * ("Homer, wielki tata"), URLs do not, so the last comma before an http(s)
 * scheme is the real separator.
 */
const LINE = /^(.*\S)\s*,\s*(https?:\/\/\S+)\s*$/;

/** `[s06e04]` — the season/episode tag filman-dl puts in front of the title. */
const TAG = /\[s(\d+)e(\d+)\]/i;

/**
 * Parse a link file.
 *
 * Bad lines are collected rather than thrown, so one mangled line does not cost
 * the caller the other twenty episodes.
 *
 * @returns {{ entries: Array<{ label: string, url: string, season: string|null,
 *   episode: string|null, lineNo: number }>, errors: Array<{ lineNo: number, text: string }> }}
 */
export function parseLinkFile(text) {
  const entries = [];
  const errors = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;

    const match = LINE.exec(line);
    if (!match) {
      errors.push({ lineNo, text: line });
      return;
    }

    const label = match[1].trim();
    const tag = TAG.exec(label);
    entries.push({
      label,
      url: match[2],
      season: tag ? tag[1].padStart(2, '0') : null,
      episode: tag ? tag[2].padStart(2, '0') : null,
      lineNo,
    });
  });

  return { entries, errors };
}

/**
 * The season a whole file belongs to: the first one that carries a tag. A file
 * holds a single season by construction, so a disagreement is the caller's to
 * report — see `seasonsIn`.
 */
export function seasonOf(entries) {
  return entries.find((entry) => entry.season)?.season ?? null;
}

/** Every distinct season tag in the file, in the order they first appear. */
export function seasonsIn(entries) {
  return [...new Set(entries.map((entry) => entry.season).filter(Boolean))];
}
