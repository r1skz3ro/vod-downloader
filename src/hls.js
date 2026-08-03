/**
 * Just enough M3U8 parsing to pick a quality and enumerate segments.
 * An HLS playlist is a plain text file: `#EXT`-prefixed tag lines interleaved
 * with URI lines. A *master* playlist lists variant streams; a *media*
 * playlist lists the actual segments.
 */

/** Split an attribute list like `BANDWIDTH=123,CODECS="a,b"` respecting quotes. */
function parseAttributes(input) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    attrs[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

export function isMasterPlaylist(text) {
  return /^#EXT-X-STREAM-INF:/m.test(text);
}

/**
 * Parse a master playlist into variants, best first.
 * @returns {Array<{url: string, bandwidth: number, width: number|null, height: number|null, codecs: string|null, label: string}>}
 */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

    // The URI is the next non-blank, non-comment line.
    let uri = null;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith('#')) continue;
      uri = candidate;
      break;
    }
    if (!uri) continue;

    const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    const [width, height] = (attrs.RESOLUTION ?? '').split('x').map((n) => Number(n) || null);
    const bandwidth = Number(attrs.BANDWIDTH ?? attrs['AVERAGE-BANDWIDTH'] ?? 0);

    variants.push({
      url: new URL(uri, baseUrl).href,
      bandwidth,
      width: width ?? null,
      height: height ?? null,
      codecs: attrs.CODECS ?? null,
      label: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)}kbps` : 'unknown',
    });
  }

  return variants.sort((a, b) => b.bandwidth - a.bandwidth || (b.height ?? 0) - (a.height ?? 0));
}

/**
 * Pick a variant. `quality` may be undefined/"best", "worst", or a height such
 * as `720` / `"720p"`, in which case the closest variant at or below that
 * height wins (falling back to the smallest if everything is taller).
 */
export function selectVariant(variants, quality) {
  if (variants.length === 0) return null;
  const sorted = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);

  if (quality == null || quality === 'best') return sorted[0];
  if (quality === 'worst') return sorted[sorted.length - 1];

  const wanted = Number(String(quality).replace(/p$/i, ''));
  if (!Number.isFinite(wanted)) return sorted[0];

  const atOrBelow = sorted.filter((v) => (v.height ?? 0) <= wanted);
  if (atOrBelow.length > 0) {
    return atOrBelow.reduce((best, v) => ((v.height ?? 0) > (best.height ?? 0) ? v : best));
  }
  return sorted[sorted.length - 1];
}

/**
 * Parse a media playlist into ordered segments plus any AES-128 key info.
 * @returns {{ segments: Array<{url: string, duration: number, key: object|null, index: number}>, mediaSequence: number, totalDuration: number }}
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let mediaSequence = 0;
  let currentKey = null;
  let pendingDuration = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      currentKey =
        !attrs.METHOD || attrs.METHOD === 'NONE'
          ? null
          : {
              method: attrs.METHOD,
              uri: attrs.URI ? new URL(attrs.URI, baseUrl).href : null,
              iv: attrs.IV ?? null,
            };
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number.parseFloat(line.slice('#EXTINF:'.length)) || 0;
      continue;
    }
    if (line.startsWith('#')) continue;

    segments.push({
      url: new URL(line, baseUrl).href,
      duration: pendingDuration,
      key: currentKey,
      index: mediaSequence + segments.length,
    });
    pendingDuration = 0;
  }

  return {
    segments,
    mediaSequence,
    totalDuration: segments.reduce((sum, s) => sum + s.duration, 0),
  };
}

/** Render the variant table shown by `--list-formats`. */
export function formatVariantTable(variants) {
  if (variants.length === 0) return '  (single stream, no quality variants)';
  return variants
    .map((v) => {
      const res = v.width && v.height ? `${v.width}x${v.height}` : '—';
      const rate = v.bandwidth ? `${(v.bandwidth / 1_000_000).toFixed(2)} Mbps` : '—';
      return `  ${v.label.padEnd(8)} ${res.padEnd(12)} ${rate.padEnd(11)} ${v.codecs ?? ''}`.trimEnd();
    })
    .join('\n');
}
