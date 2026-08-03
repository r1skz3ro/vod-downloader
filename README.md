# voe-dl

A Node.js downloader for [voe.sx](https://voe.sx). It reverses the site's
client-side URL obfuscation, resolves the resulting HLS stream, and writes a
playable MP4.

Zero runtime dependencies — everything it needs (`fetch`, `node:crypto`,
`parseArgs`, `readline`) ships with Node 20+. `ffmpeg` is used when present and
is not required.

---

## Quick start

### My use case

```bash
node bin/filman.js --out links.txt https://filman.cc/s/673/simpsonowie-the-simpsons # it will save the links to links.txt
node bin/voe.js -f links.txt # It will store videos from links.txt in ./downloads
```

### General usage

```bash
node bin/voe.js https://voe.sx/e/xxxxxxxxxxxx      # download to ./downloads
node bin/voe.js -f links.txt                       # download a whole season
node bin/voe.js                                    # interactive prompt
npm test                                           # offline test suite
```

```
Usage:
  voe-dl <url> [<url> ...]      download one or more videos
  voe-dl -f <file>              download every episode in a link file
  voe-dl                        start the interactive prompt

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
```

`--url-only` writes only the URL to stdout (all diagnostics go to stderr), so it
pipes cleanly:

```bash
node bin/voe.js --url-only https://voe.sx/e/xxxx | xargs mpv
```

---

## Downloading a season from a link file

`-f/--file` takes the labelled file `filman-dl -o` writes — one episode per line,
its label then its URL:

```
[s06e01] Bart na tropie, https://embed.tmp-url.pro/7363876/…
[s06e02] Rywalka Lisy, https://embed.tmp-url.pro/7363880/…
```

The label becomes the filename and the `[sNNeMM]` tag the folder, so

```bash
node bin/voe.js -f links.txt
```

fills `./The Simpsons season 06/` with `[s06e01] Bart na tropie.mp4` and friends.
`--show` names a different series, and `-o` puts the season folder somewhere
other than the repo root. A file holds one season; a mixed one is a warning, and
the first season tag wins.

Four episodes download at once (`-j` from 1 to 8), each still fetching `-c`
segments in parallel. A terminal gets one live bar per running episode plus a
tally; redirected to a file, the same run prints a `start`/`done`/`skip`/`fail`
line per episode instead.

```
  [s06e05] Pomocnik Bob Roberts     [##############----]  80%   412 MB  8.1 MB/s
  [s06e06] Straszny domek na drzewi [####--------------]  22%    98 MB  5.4 MB/s
  [s06e07] Dziewczyna Barta          resolving…
  [s06e08] Lisa na lodzie           [##----------------]  11%    47 MB  4.9 MB/s
  4/25 done, 0 failed
```

Episodes already on disk are skipped, so a run interrupted halfway resumes by
running the same command again; `--force` downloads them anyway. Failures do not
stop the rest — they are listed at the end, and the exit status is 1.

`--ffmpeg` is ignored here: its one-pass mode writes its own progress to the
terminal, which would fight the display.

---

## Collecting links from filman.cc

`voe-dl` starts from a link you already have. `filman-dl` is the separate module
that finds those links: give it a filman.cc series page, pick a season and some
episodes, and it prints one VOE embed URL per line.

```bash
node bin/filman.js https://filman.cc/s/673/simpsonowie-the-simpsons
```

```
Seasons (episode counts in brackets):
    1 (13)   2 (22)   3 (24)   4 (22)   5 (22)   6 (25)
    ...

Season> 11

Season 11 — 22 episodes
   1) [s11e01] Pod kopułą chały
   2) [s11e02] Odpał Barta
   ...

Episodes (e.g. 1,3,5-8 or all)> 1,3,5-8
```

Only the URLs go to stdout — prompts and progress go to stderr — so the output
redirects and pipes cleanly:

```bash
node bin/filman.js --season 11 --episodes 1,3,5-8 <series-url> > links.txt
node bin/filman.js --season 11 --episodes all      <series-url> | xargs node bin/voe.js
```

`-o/--out` writes the same links to a file, but labelled with the episode they
came from — stdout stays bare URLs so the pipes above keep working:

```
[s05e01] Homer w zespole rewelersów, https://embed.tmp-url.pro/7621444/…
[s05e02] Kwiaty dla Barta, https://embed.tmp-url.pro/7621445/…
```

```
Options:
  -o, --out <file>         also write the links to a file, one labelled
                           `[sNNeMM] Title, <url>` per line
      --cookie <string>    filman.cc cookies      (or set FILMAN_COOKIE)
      --user-agent <ua>    matching User-Agent    (or set FILMAN_UA)
      --season <n>         answer the season prompt up front
      --episodes <spec>    answer the episode prompt up front (1,3,5-8 | all)
      --delay <ms>         pause between episodes (default: 1500)
      --debug              print stack traces on failure
```

The collected URLs embed a timestamp and expire, so use them promptly.

### Rate limiting

filman.cc limits how fast the `/link/token` endpoint may be called; over the
limit it answers `429 Za szybko, spróbuj za chwilę` ("too fast, try in a
moment"). A whole season asked for back to back will trip it, so the run paces
itself: `--delay` (jittered) between episodes, a refused episode waited out and
retried after 10s, 30s and 60s, and the pace doubled for the rest of the run
each time the site pushes back. Lower `--delay` if you are collecting a couple
of links; raise it if you are still being refused.

### Cookies

filman.cc sits behind Cloudflare, but in practice it serves these pages
unchallenged most of the time — try without credentials first. If you are
challenged, copy the `Cookie` header from a browser (DevTools → Network → any
request) **together with that browser's User-Agent**: Cloudflare binds
`cf_clearance` to the UA that earned it, so the cookie alone will be rejected.

```bash
export FILMAN_COOKIE='PHPSESSID=…; cf_clearance=…'
export FILMAN_UA='Mozilla/5.0 (Macintosh; …) Chrome/148.0.0.0 Safari/537.36'
```

### Why no browser is needed

The site looks like it requires one: you click a `voe.sx` row, and only then
does a "Przejdź do Odtwarzacza." button appear carrying the link. But that click
is an XHR, not a navigation. The page's own handler does:

```js
var routeToken = '9619c4d7';
$('.link-to-video a').click(function () {
  $.ajax({ url: '/link/token',
           data: { link_id: $(this).data('link-id'), rt: routeToken },
           headers: { 'X-Requested-With': 'XMLHttpRequest' }, … })
```

and builds the button's `href` from `atob(resp.url)`. So `src/filman.js` scrapes
the link id and `routeToken` off the episode page, calls `/link/token` directly,
and base64-decodes the answer — plain HTTP, no automation. Two details matter:
`X-Requested-With` is mandatory (the site answers `400` without it), and a stale
`rt` is rejected with `403` even though the parameter is optional, so a scraped
token is retried without it rather than trusted.

What comes back is an embed wrapper, which is exactly what `src/embed.js`
already unwraps — the new module hands straight to the existing pipeline.

---

## "There's no .mp4 in the page source. How can this work at all?"

This is the central question, and the answer has two halves.

### Half 1: there is no MP4 because the video isn't one file

VOE doesn't serve a single video file. It serves **HLS** (HTTP Live Streaming),
which represents a video as:

- a **manifest** — a plain text `.m3u8` file listing the pieces, and
- a few hundred to a few thousand **segments** — `.ts` files of roughly 2–10
  seconds each, fetched one at a time as you watch.

There are usually two manifest layers. The _master_ playlist lists the available
qualities; each entry points at a _media_ playlist that lists that quality's
actual segments:

```
master.m3u8                                media playlist (720p)
┌──────────────────────────────────┐       ┌────────────────────────┐
│ #EXT-X-STREAM-INF:               │       │ #EXTINF:9.009,         │
│   BANDWIDTH=5000000,             │──────▶│ seg0.ts                │
│   RESOLUTION=1920x1080           │       │ #EXTINF:9.009,         │
│ 1080/index.m3u8                  │       │ seg1.ts                │
│ #EXT-X-STREAM-INF:               │       │ #EXTINF:9.009,         │
│   BANDWIDTH=2800000,             │       │ seg2.ts   … × 800      │
│   RESOLUTION=1280x720            │       └────────────────────────┘
│ 720/index.m3u8                   │
└──────────────────────────────────┘
```

So "right-click → Save video as…" has nothing to grab. **The file you want does
not exist on the server as a single object.** It exists as a playlist plus its
pieces, and the browser stitches them together in memory as you watch.

Worth being clear about: this is not primarily an anti-download measure. HLS
exists so players can switch bitrate mid-stream when your connection changes,
seek without downloading the whole file, and let CDNs cache small chunks. Making
downloading inconvenient is a side effect that VOE then leans into.

### Half 2: the obfuscation cannot work, and that's not fixable

VOE additionally hides the manifest URL. It isn't in the HTML as text; it's
buried in a scrambled string that JavaScript unscrambles at page load.

Here is the thing that makes the whole exercise possible:

> **The browser has to be able to un-hide the URL, with no help from the server.
> So every ingredient needed to un-hide it is already on your machine.**

The scrambling is done by JavaScript that VOE ships to you. To play the video,
your browser must run that JavaScript and recover a plain URL, then make an
ordinary HTTP request for it. Anything the player can fetch, a script can fetch.
Reading VOE's own code and reimplementing its unscrambling in Node is just doing
by hand what the page does automatically.

**Obfuscation is not encryption.** Encryption is secure when the key is secret.
Here there is no secret: the "key" is the algorithm, and the algorithm is
published to every visitor. Obfuscation only buys the time it takes someone to
read the code once. After that it's a fixed recipe — which is exactly what this
tool implements.

---

## The obfuscation, step by step

The payload sits in the page as a JSON array holding one long string:

```html
<script type="application/json">
  ["PE1GUjRRV2V4TFtdM1F..."]
</script>
```

Six reversible transforms, undone in order:

| #   | Step              | What it does                                             |
| --- | ----------------- | -------------------------------------------------------- |
| 1   | **ROT13**         | Rotate each letter 13 places. Self-inverse.              |
| 2   | **Strip junk**    | Delete the seven filler digraphs `@$ ^^ ~@ %? *~ !! #&`. |
| 3   | **Base64 decode** | First layer off.                                         |
| 4   | **Shift −3**      | Subtract 3 from every character code.                    |
| 5   | **Reverse**       | Reverse the string.                                      |
| 6   | **Base64 decode** | Second layer off — this yields UTF-8 JSON.               |

Run `--debug` to watch it happen. This is real output from the project's test
server, which builds a payload with the _inverse_ pipeline:

```
0. payload      480  CR1TH*~wEEI2~@I4GSg@$qZ1So!!KUp8s%?TM2nm^^ICr1O#&9HGql*~I1O4E…
1. rot13        480  PE1GU*~jRRV2~@V4TFt@$dM1Fb!!XHc8f%?GZ2az^^VPe1B#&9UTdy*~V1B4R…
2. strip junk   344  PE1GUjRRV2V4TFtdM1FbXHc8fGZ2azVPe1B9UTdyV1B4RG1Pejd8UXxIfU95c…
3. base64       256  <MFR4QWexL[]3Q[\w<|fvk5O{P}Q7rWPxDmOz7|Q|H}OyrGf3UKdlrmLoQpf…
4. charCode -3  256  9JCO1NTbuIXZ0NXYt9ycsh2LxMzN4oTMuAjLw4yNyEzLvoDc0RHaiojIlNmc…
5. reverse      256  eyJ0aXRsZSI6Imlnbm9yZWQiLCJ0aHVtYm5haWxzIjoiaHR0cDovLzEyNy4w…
6. base64       192  {"title":"ignored","thumbnails":"http://127.0.0.1:8731/hls/…
```

Step 5's output starting with `eyJ` is the giveaway — that's what
`{"` looks like in Base64, so you can see the JSON coming one step early.

Two details that are easy to get wrong:

- **The junk digraphs contain no letters**, so ROT13 leaves them untouched.
  Steps 1 and 2 therefore commute; order doesn't matter.
- **The junk is deleted, not replaced.** See the porting note below — this one
  bites specifically in JavaScript.

### What real protection would look like

DRM — Widevine, PlayReady, FairPlay. There, the content key is negotiated with a
license server and handed to a hardware-backed secure environment that
JavaScript cannot read; decryption happens somewhere the page itself can't
observe. That is a genuinely different security model, and a tool like this one
cannot touch it.

VOE uses none of that. At most you'll encounter **AES-128 HLS**, where the
manifest names its own key file:

```
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123...
```

The player must fetch `key.bin` over plain HTTP to play the video, so we fetch it
the same way and decrypt with `node:crypto`. It stops casual copying of segments
in isolation; it does not stop a client that follows the manifest.

---

## How the tool works

```
  URL
   │
   ▼
 ┌──────────────────────────────────────────────────────────┐
 │ src/embed.js    embed wrapper? recover the framed URL    │
 │                 (skipped outright for a VOE host)        │
 └──────────────────────────────────────────────────────────┘
   │ VOE URL
   ▼
 ┌──────────────────────────────────────────────────────────┐
 │ src/http.js     fetch + cookie jar + browser headers     │
 │                 (voe.sx sits behind DDoS-Guard)          │
 └──────────────────────────────────────────────────────────┘
   │ HTML
   ▼
 ┌──────────────────────────────────────────────────────────┐
 │ src/extract.js  follow JS mirror redirect                │
 │                 find payload → deobfuscate → rank URLs   │
 └──────────────────────────────────────────────────────────┘
   │ .m3u8
   ▼
 ┌──────────────────────────────────────────────────────────┐
 │ src/hls.js      parse master playlist → pick quality     │
 └──────────────────────────────────────────────────────────┘
   │ media playlist
   ▼
 ┌──────────────────────────────────────────────────────────┐
 │ src/download.js fetch segments (AES-128 + concat)        │
 │                 → ffmpeg remux to MP4, local, -c copy    │
 └──────────────────────────────────────────────────────────┘
   │
   ▼
 downloads/<title>.mp4
```

| File                 | Responsibility                                            |
| -------------------- | --------------------------------------------------------- |
| `bin/voe.js`         | CLI, argument parsing, interactive loop                   |
| `src/deobfuscate.js` | the six-step pipeline (pure, no I/O)                      |
| `src/embed.js`       | resolve a third-party embed page to the VOE URL it frames |
| `src/http.js`        | cookie jar, browser-shaped headers, retry/backoff         |
| `src/extract.js`     | mirror redirects, payload discovery, stream ranking       |
| `src/hls.js`         | M3U8 parsing and quality selection                        |
| `src/download.js`    | segment downloader, ffmpeg remux, optional ffmpeg engine  |

A few decisions worth calling out:

**Embed wrappers are unwrapped first, and the iframe has no `src`.** Links are
usually shared as a third-party player page rather than a bare VOE URL. Those
pages ship an empty `<iframe id="pl">` and assign `iframe.src` from JavaScript
only after a click-through overlay, holding the destination as a base64'd XOR
ciphertext whose key is spliced from a few short literals:

```js
var _e = "XE1MSENfFkoUXgcYF0sYABsBQQoEHF0dBksWWgc=";
var _a = "49880";
var _b = "e9eb1b";
var _c = "6d37e";
var src = _xd(_e, _a + _b + _c); // → https://voe.sx/e/8y24ydxdztlc
```

So scanning for `src="…"` finds nothing, and `src/embed.js` reverses the cipher
instead — no headless browser, no new dependency. The variable names are
regenerated per page, so the operands are recovered structurally from the decode
call; if that shape changes, it falls back to trying every literal pairing and
keeps only what decodes to a well-formed URL. A URL already on a VOE host skips
this stage entirely, without a request. Note the bytes must be read as `latin1`
to match what `atob` hands the browser — decoding as UTF-8 mangles everything
above `0x7f` before the XOR runs.

**Extraction tries four strategies in order.** The `<script type="application/json">`
tag is the intended location; if VOE moves it, the tool brute-forces every
`["…"]` literal in every `<script>`, then looks for legacy `sources:`/`hls:`
objects, then scans for a bare `.m3u8` URL. It degrades instead of dying.

**Cookies are mandatory.** voe.sx is fronted by DDoS-Guard, which issues
`__ddg1_`/`__ddg8_`/`__ddg9_`/`__ddg10_` on first contact and expects them back
on every later request, including to the CDN. Node's global `fetch` does not
persist cookies, so `src/http.js` keeps a jar and replays them — and passes them
to ffmpeg via `-headers` as well.

**All candidate URLs are ranked, not first-matched.** A decoded payload often
contains a thumbnail sprite and a progressive URL alongside the real stream.
The ranking prefers `.m3u8`, prefers keys named `source`/`hls`/`file`, and
actively penalises anything matching `thumb|preview|sprite|poster|trailer`.

**We fetch, ffmpeg muxes.** ffmpeg is perfectly capable of pulling an HLS
manifest itself, and that used to be the default — but its HLS demuxer sends one
static `-headers` blob for every segment, and VOE's delivery nodes start
answering with `403 Forbidden` partway through a long stream. The built-in
downloader runs every segment through `src/http.js`, so each request carries the
live cookie jar, `Referer`/`Origin` and `Sec-Fetch-Site: cross-site` that won us
the manifest, and retries with backoff. So segments are ours and muxing is
ffmpeg's, on a local file with no network involved. `--ffmpeg` restores the
one-pass behaviour for CDNs that tolerate it.

**Nothing is ever re-encoded.** Every path is a stream copy, so the output is
bit-for-bit the media the player received. Downloads are written to a `.part`
file and renamed on success, so an interrupted run never leaves a plausible-looking
truncated file behind.

## Troubleshooting

| Symptom                             | Cause and fix                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `no stream URL found`               | VOE changed its obfuscation. Run with `--debug` to see which strategies were tried and how far each got.                                                                                               |
| `no iframe source found`            | The URL isn't an embed wrapper, or the wrapper changed how it hides the player URL. Check the page really does frame a VOE player; `--debug` prints the URL each hop resolves to.                      |
| `HTTP 403` on segments              | Cookie or `Referer` rejected. Usually transient rate limiting — retry; the client already backs off. If you passed `--ffmpeg`, drop it: ffmpeg cannot reproduce the per-segment headers the CDN wants. |
| `HTTP 404` on the embed page        | Video removed, or the ID is wrong.                                                                                                                                                                     |
| Output is `.ts`, not `.mp4`         | ffmpeg wasn't available to remux. Install it, or accept the `.ts` — it plays fine in VLC/mpv.                                                                                                          |
| `unsupported HLS encryption method` | The stream uses SAMPLE-AES or real DRM, which this tool does not handle.                                                                                                                               |
| Downloads are slow                  | Raise `--concurrency` (max 32). Note that `--ffmpeg` is single-connection and ignores `--concurrency`.                                                                                                 |
| `no episode list found` (filman)    | Not a series page — the URL must be a `/s/…` page, not `/e/…`. If it is, Cloudflare likely served a challenge instead: supply `FILMAN_COOKIE` and a matching `FILMAN_UA`.                              |
| `no voe.sx hosting is listed`       | That episode is only mirrored on other hosts. The run continues; only that episode is skipped.                                                                                                         |
| `the site refused to hand out …`    | `/link/token` rejected the request. Usually stale cookies; the stale-`rt` case is already retried automatically.                                                                                       |

---

## Testing

```bash
npm test
```

85 tests, fully offline, no network and no captured page content. The suite
carries the _inverse_ of both the deobfuscation pipeline and the embed cipher as
helpers, so every test generates its own payload. It covers the round trip,
non-ASCII payloads, nested structures, error reporting, the `_`/`-` Base64
hazard, M3U8 master and media parsing, quality selection, URL ranking, filename
sanitising, and embed resolution — including renamed variables, a restructured
decode call that forces the brute-force fallback, and VOE-first ranking when a
page hides more than one URL.

The filman suite synthesises its own series and episode markup the same way. It
covers the nested season list (where splitting on `<li>` would fold every
episode into the first season), the newest-first re-sort, title tidying,
relative href resolution, preferring `data-link-id` over `data-id` while
ignoring non-VOE hostings, the `data-mp4` branch, and the selection grammar —
ranges, `all`, duplicates, reversed ranges and out-of-bounds input.

The link-file and pool suites cover the parsing hazards — a comma inside a
title, an untagged line, malformed lines that must not cost the file its other
episodes — and the pool's guarantees: the window never widens past the limit, a
finished job is replaced immediately rather than at the end of a batch, results
stay in input order, a slot is never held twice at once, and one rejecting job
neither stops the others nor escapes as an unhandled rejection.

The download paths were verified end-to-end against a local server that
impersonates VOE — JS mirror redirect, DDoS-Guard cookie gate, `Referer` check,
a genuinely obfuscated payload, and real AES-128-encrypted HLS renditions. Both
engines were confirmed to produce valid 12.0 s H.264/AAC output at the requested
resolution, including with ffmpeg removed from `PATH`.

---

## Legal

This is an educational exercise in reverse-engineering client-side obfuscation.
Use it only for content you own or are otherwise authorised to download, and
respect voe.sx's terms of service and applicable copyright law. Downloading
copyrighted material you have no rights to is illegal in most jurisdictions.
The same caveats apply here as to any general-purpose tool of this kind, such as
`yt-dlp`.
