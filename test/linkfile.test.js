import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLinkFile, seasonOf, seasonsIn } from '../src/linkfile.js';

const URL_A = 'https://embed.tmp-url.pro/7363876/1785589084/464741879566c447/';
const URL_B = 'https://embed.tmp-url.pro/7363880/1785589087/a2c9cc61b10c67a6/';

test('parses the lines filman-dl writes', () => {
  const { entries, errors } = parseLinkFile(
    `[s06e01] Bart na tropie, ${URL_A}\n[s06e02] Rywalka Lisy, ${URL_B}\n`,
  );

  assert.equal(errors.length, 0, 'well-formed lines produce no errors');
  assert.deepEqual(
    entries.map((entry) => [entry.label, entry.url, entry.season, entry.episode]),
    [
      ['[s06e01] Bart na tropie', URL_A, '06', '01'],
      ['[s06e02] Rywalka Lisy', URL_B, '06', '02'],
    ],
  );
});

test('a comma in the title does not split the line', () => {
  const { entries } = parseLinkFile(`[s06e09] Homer, złoczyńca i reszta, ${URL_A}`);

  assert.equal(entries[0].label, '[s06e09] Homer, złoczyńca i reszta');
  assert.equal(entries[0].url, URL_A, 'the URL is taken from the last comma');
});

test('blank lines and comments are ignored', () => {
  const { entries, errors } = parseLinkFile(
    `\n# season 6, dubbed\n\n[s06e01] Bart na tropie, ${URL_A}\n   \n`,
  );

  assert.equal(entries.length, 1);
  assert.equal(errors.length, 0, 'a comment is not a parse error');
});

test('an untagged title parses, without a season', () => {
  const { entries } = parseLinkFile(`Some one-off video, ${URL_A}`);

  assert.equal(entries[0].label, 'Some one-off video');
  assert.equal(entries[0].season, null);
  assert.equal(entries[0].episode, null);
});

test('single-digit tags are padded to two digits', () => {
  const { entries } = parseLinkFile(`[s6e4] Kraina Zdrapka, ${URL_A}`);

  assert.equal(entries[0].season, '06');
  assert.equal(entries[0].episode, '04');
});

test('malformed lines are collected, not thrown, and keep their line numbers', () => {
  const { entries, errors } = parseLinkFile(
    `[s06e01] Bart na tropie, ${URL_A}\n[s06e02] Rywalka Lisy — no url here\n[s06e03] Powtórka, ${URL_B}`,
  );

  assert.equal(entries.length, 2, 'the good lines still come through');
  assert.deepEqual(
    errors.map((error) => error.lineNo),
    [2],
  );
});

test('a bare URL with no title is an error', () => {
  const { entries, errors } = parseLinkFile(URL_A);

  assert.equal(entries.length, 0);
  assert.equal(errors.length, 1, 'there is no label to name the file after');
});

test('seasonOf takes the first tagged entry, seasonsIn reports every season present', () => {
  const { entries } = parseLinkFile(
    `Untagged extra, ${URL_A}\n[s06e01] Bart na tropie, ${URL_A}\n[s07e01] Kto postrzelił, ${URL_B}\n[s06e02] Rywalka Lisy, ${URL_B}`,
  );

  assert.equal(seasonOf(entries), '06');
  assert.deepEqual(seasonsIn(entries), ['06', '07'], 'each season appears once, in first-seen order');
});

test('seasonOf returns null when nothing is tagged', () => {
  const { entries } = parseLinkFile(`Some one-off video, ${URL_A}`);

  assert.equal(seasonOf(entries), null);
  assert.deepEqual(seasonsIn(entries), []);
});
