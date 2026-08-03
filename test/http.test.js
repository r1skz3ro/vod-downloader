import test from 'node:test';
import assert from 'node:assert/strict';

import { clientHintsFor, fetchSiteFor, getText, setUserAgent, USER_AGENT } from '../src/http.js';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/148.0.0.0 Safari/537.36';

const FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';

test('fetchSiteFor derives what a browser would send', () => {
  const page = 'https://filman.cc/e/123';

  assert.equal(fetchSiteFor(page, undefined), 'none');
  assert.equal(fetchSiteFor(page, 'https://filman.cc'), 'same-origin');
  assert.equal(fetchSiteFor(page, 'https://www.filman.cc/s/673'), 'same-site');
  assert.equal(fetchSiteFor(page, 'https://voe.sx/e/abc'), 'cross-site');
  assert.equal(fetchSiteFor(page, 'http://filman.cc'), 'cross-site', 'scheme is part of origin');
  assert.equal(fetchSiteFor(page, 'not a url'), 'cross-site');
});

test('client hints are derived from the User-Agent, or omitted entirely', () => {
  const chrome = clientHintsFor(CHROME_MAC);
  assert.match(chrome['Sec-CH-UA'], /"Google Chrome";v="148"/);
  assert.equal(chrome['Sec-CH-UA-Platform'], '"macOS"');
  assert.equal(chrome['Sec-CH-UA-Mobile'], '?0');

  assert.equal(clientHintsFor(USER_AGENT)['Sec-CH-UA-Platform'], '"Windows"');

  // A UA that does not send these headers must not be given them: an invented
  // hint is a worse signal than a missing one.
  assert.deepEqual(clientHintsFor(FIREFOX), {});
  assert.deepEqual(clientHintsFor('curl/8.7.1'), {});
});

/** Capture the headers of one request without touching the network. */
async function headersOf(url, options) {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (_url, init) => {
    seen = init.headers;
    return new Response('ok', { status: 200 });
  };
  try {
    await getText(url, options);
    return seen;
  } finally {
    globalThis.fetch = original;
  }
}

test('a Referer passed through headers still gets a matching Sec-Fetch-Site', async () => {
  // This is the shape `resolveEpisode` sends, which used to go out claiming
  // `Sec-Fetch-Site: none` alongside a Referer.
  const headers = await headersOf('https://filman.cc/e/123', {
    headers: { Referer: 'https://filman.cc' },
  });
  assert.equal(headers['Sec-Fetch-Site'], 'same-origin');
});

test('the referer option still reads as cross-site for CDN requests', async () => {
  const headers = await headersOf('https://delivery.example.net/seg.ts', {
    referer: 'https://voe.sx/e/abc',
  });
  assert.equal(headers['Sec-Fetch-Site'], 'cross-site');
  assert.equal(headers.Origin, 'https://voe.sx', 'the Origin side effect is unchanged');
});

test('an explicit Sec-Fetch-Site wins over the derived one', async () => {
  const headers = await headersOf('https://filman.cc/link/token', {
    headers: { Referer: 'https://voe.sx/x', 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(headers['Sec-Fetch-Site'], 'same-origin');
});

test('setUserAgent swaps the hints along with the UA', async () => {
  try {
    setUserAgent(CHROME_MAC);
    let headers = await headersOf('https://filman.cc/', {});
    assert.equal(headers['User-Agent'], CHROME_MAC);
    assert.equal(headers['Sec-CH-UA-Platform'], '"macOS"');

    setUserAgent(FIREFOX);
    headers = await headersOf('https://filman.cc/', {});
    assert.equal(headers['User-Agent'], FIREFOX);
    assert.equal(headers['Sec-CH-UA'], undefined, 'the stale Chrome hints are dropped');
    assert.equal(headers['Sec-CH-UA-Platform'], undefined);
  } finally {
    setUserAgent(USER_AGENT); // BASE_HEADERS is module state shared with other suites
  }
});
