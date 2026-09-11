/**
 * A tiny per-process cache for Etsy reads that rarely change (shop
 * sections, processing profiles, shop name, taxonomy). Combines a TTL with
 * in-flight de-duplication so two near-simultaneous callers for the same
 * key (e.g. React Strict Mode firing an effect twice in dev) share one
 * upstream call instead of doubling it. Not persisted — cleared on server
 * restart/redeploy, which is fine since Etsy is always the source of
 * truth. A failed fetch is never cached, so the next call retries.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { at: number; value: V }>();
  private readonly pending = new Map<K, Promise<V>>();

  constructor(private readonly ttlMs: number) {}

  async get(key: K, fetcher: () => Promise<V>): Promise<V> {
    const cached = this.entries.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.value;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const promise = fetcher()
      .then((value) => {
        this.entries.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }
}
