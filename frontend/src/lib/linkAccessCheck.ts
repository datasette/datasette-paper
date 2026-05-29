/**
 * AccessChecker — per-connection helper that fetches the doc's
 * cross-access report (`/-/paper/api/docs/{docId}/link-access-check`) once,
 * caches it keyed by target doc id, and notifies subscribers after each
 * (re)load so paper-link NodeViews can re-render their warning badge.
 *
 * The endpoint is EDIT-GATED: it returns 403 for non-editors. A non-editor
 * therefore just gets an empty cache (no badges) — the checker self-gates,
 * so callers don't need to thread a `canManage` flag through.
 *
 * Per target the report says whether some named collaborator of THIS doc
 * can't view the target (`gap` + `missing` ids) and whether the doc's
 * audience can't be fully enumerated (`open_audience`, a softer "may be more
 * private" hint).
 */

export interface AccessGap {
  gap: boolean;
  missing: string[];
  open_audience: boolean;
}

type Subscriber = () => void;

export class AccessChecker {
  private docId: string;
  private cache = new Map<number, AccessGap>();
  private subscribers = new Set<Subscriber>();
  // Set once the first load() is kicked off, so ensureLoaded() is a no-op on
  // subsequent NodeView subscriptions. A NodeView triggers the (single) load
  // lazily — like LinkResolver, no fetch fires for a doc that has no
  // paper_link to check, which keeps fetch-order-sensitive tests untouched.
  private loadStarted = false;

  constructor(docId: string) {
    this.docId = docId;
  }

  /**
   * Kick off the one-shot load the first time anything cares (a NodeView
   * subscribing). Idempotent; subsequent calls are no-ops. Fire-and-forget.
   */
  ensureLoaded(): void {
    if (this.loadStarted) return;
    this.loadStarted = true;
    void this.load();
  }

  /**
   * Fetch the report once and populate the cache. A 403 (non-editor) or any
   * network error leaves the cache empty — no badges. Safe to call
   * repeatedly; a later call re-fetches on demand. Always notifies
   * subscribers on success so NodeViews re-render once data arrives.
   */
  async load(): Promise<void> {
    try {
      const resp = await fetch(
        `/-/paper/api/docs/${this.docId}/link-access-check`,
      );
      if (!resp.ok) {
        // 403 for non-editors, or any other failure: leave cache empty.
        return;
      }
      const json = (await resp.json()) as {
        links?: Record<string, AccessGap>;
      };
      const links = json.links ?? {};
      this.cache.clear();
      for (const [key, value] of Object.entries(links)) {
        this.cache.set(Number(key), value);
      }
      this.notify();
    } catch {
      // Swallow network errors: no badges rather than a thrown rejection.
    }
  }

  /** The gap report for a target doc id, or undefined until loaded / absent. */
  get(dstId: number): AccessGap | undefined {
    return this.cache.get(dstId);
  }

  /**
   * Register to be notified after each (re)load. Returns an unsubscribe fn.
   */
  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    this.ensureLoaded();
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Clear subscribers. No timers here, but kept for symmetry with peers. */
  dispose(): void {
    this.subscribers.clear();
  }

  private notify(): void {
    for (const cb of this.subscribers) cb();
  }
}
