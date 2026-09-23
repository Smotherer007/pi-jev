/** A small concurrency pool, shared by triage, trim and prune. */

/**
 * Run `worker` over `items` with at most `limit` in flight, keeping input order
 * in the output. A tiny pool rather than a dependency.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return out;
}

