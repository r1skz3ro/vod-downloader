import test from 'node:test';
import assert from 'node:assert/strict';

import { runPool } from '../src/pool.js';

/** A promise plus the handles to settle it, so a test drives the timing. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('never runs more than `limit` workers at once', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  const gates = items.map(() => deferred());
  let inFlight = 0;
  let peak = 0;

  const done = runPool(
    items,
    async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gates[item - 1].promise;
      inFlight--;
      return item;
    },
    { limit: 3 },
  );

  await tick();
  assert.equal(inFlight, 3, 'the window fills up front');

  // Release them one at a time; each release should pull exactly one more in.
  for (const gate of gates) {
    gate.resolve();
    await tick();
  }

  await done;
  assert.equal(peak, 3, 'the window never widened');
});

test('a finished job is replaced immediately, not at the end of a batch', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const started = [];

  const done = runPool(
    [0, 1, 2],
    async (item) => {
      started.push(item);
      await gates[item].promise;
    },
    { limit: 2 },
  );

  await tick();
  assert.deepEqual(started, [0, 1]);

  gates[1].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2], 'the third started while the first was still running');

  gates[0].resolve();
  gates[2].resolve();
  await done;
});

test('results come back in input order, whatever order they finish in', async () => {
  const results = await runPool(
    [30, 10, 20],
    async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    },
    { limit: 3 },
  );

  assert.deepEqual(
    results.map((result) => result.value),
    [30, 10, 20],
  );
});

test('a rejecting worker is reported, and the rest still run', async () => {
  const seen = [];

  const results = await runPool(
    ['a', 'boom', 'c'],
    async (item) => {
      seen.push(item);
      if (item === 'boom') throw new Error('nope');
      return item.toUpperCase();
    },
    { limit: 1 },
  );

  assert.deepEqual(seen, ['a', 'boom', 'c'], 'the failure did not stop the pool');
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'rejected', 'fulfilled'],
  );
  assert.equal(results[1].reason.message, 'nope');
  assert.equal(results[1].item, 'boom', 'the failed item comes back with its result');
});

test('each worker gets a slot index below the limit, and slots are reused', async () => {
  const slots = [];

  await runPool(
    [1, 2, 3, 4, 5],
    async (item, slot) => {
      slots.push(slot);
      await tick();
    },
    { limit: 2 },
  );

  assert.equal(slots.length, 5);
  assert.ok(
    slots.every((slot) => Number.isInteger(slot) && slot >= 0 && slot < 2),
    `slots stayed inside the window: ${slots.join(',')}`,
  );
});

test('a slot is never held by two workers at the same time', async () => {
  const gates = [0, 1, 2, 3, 4, 5].map(() => deferred());
  const held = new Set();
  let clash = false;

  const done = runPool(
    [0, 1, 2, 3, 4, 5],
    async (item, slot) => {
      if (held.has(slot)) clash = true;
      held.add(slot);
      await gates[item].promise;
      held.delete(slot);
    },
    { limit: 3 },
  );

  for (const gate of gates) {
    gate.resolve();
    await tick();
  }
  await done;

  assert.equal(clash, false, 'no two concurrent workers shared a slot');
});

test('an empty list resolves to an empty result set', async () => {
  assert.deepEqual(await runPool([], async () => 'never', { limit: 4 }), []);
});
