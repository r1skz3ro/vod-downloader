/**
 * A fixed-width worker pool: at most `limit` items in flight, and the next item
 * starts the moment any one of them finishes rather than waiting for the whole
 * batch. `Promise.all` over chunks of `limit` would idle behind the slowest
 * item in each chunk, which for episodes that differ in length is most of them.
 */

/**
 * Run `worker` over `items`, never more than `limit` at a time.
 *
 * The worker is handed a free slot index alongside its item, so callers that
 * draw one progress line per concurrent job know which line is theirs. Slots
 * are recycled: a finished job's slot goes to the item that replaces it.
 *
 * Rejections are captured, not propagated — every item gets its turn, and the
 * caller reads the outcomes off the returned array, which is in input order.
 *
 * @param {Array} items
 * @param {(item: any, slot: number) => Promise<any>} worker
 * @param {{ limit?: number }} [options]
 * @returns {Promise<Array<{ item: any, status: 'fulfilled'|'rejected', value?: any, reason?: any }>>}
 */
export async function runPool(items, worker, { limit = 4 } = {}) {
  const results = new Array(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  const freeSlots = Array.from({ length: width }, (_, i) => i);

  let next = 0;

  const runner = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;

      const slot = freeSlots.pop();
      try {
        results[index] = { item: items[index], status: 'fulfilled', value: await worker(items[index], slot) };
      } catch (reason) {
        results[index] = { item: items[index], status: 'rejected', reason };
      } finally {
        freeSlots.push(slot);
      }
    }
  };

  // Each runner already swallows its worker's rejections, so the only way one
  // of these settles rejected is a bug in the loop itself; `allSettled` keeps
  // that from taking the other runners' in-flight work down with it.
  const runners = Array.from({ length: width }, () => runner());
  const outcomes = await Promise.allSettled(runners);
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed) throw failed.reason;

  return results;
}
