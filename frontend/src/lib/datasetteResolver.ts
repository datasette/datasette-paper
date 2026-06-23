/**
 * DatasetteResolver — batches `datasette_ref` path resolution into a single
 * POST to `/-/paper/api/datasette/resolve`, caches results, and notifies
 * per-ref subscribers. Mirrors `linkResolver.ts` (which models the
 * `denied`/`not_found` states we need), keyed by the ref path string.
 *
 * One resolver lives per editor. Inline-pill NodeViews (datasetteRefView.ts)
 * call `request(ref, cb)` to learn a resource's label/kind, and unsubscribe
 * from `destroy()`. Refs requested in one tick coalesce into one POST; resolved
 * statuses are cached so a repeat request is answered synchronously.
 */

export type DatasetteStatus =
  | {
      status: "ok";
      kind: string;
      label: string;
      href: string;
      db?: string;
      table?: string;
      pk?: string;
      count?: number;
      /** Optional bootstrap-icon name hint (provider refs, e.g. "globe"). */
      icon?: string;
    }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "loading" };

export const DATASETTE_RESOLVE_ENDPOINT = "/-/paper/api/datasette/resolve";

type Subscriber = (status: DatasetteStatus) => void;

export class DatasetteResolver {
  private endpoint: string;
  private cache = new Map<string, DatasetteStatus>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(endpoint: string = DATASETTE_RESOLVE_ENDPOINT) {
    this.endpoint = endpoint;
  }

  /**
   * Register interest in `ref`. Invokes `cb` synchronously with the current
   * best-known status (cached, or `{status:"loading"}`), then again
   * asynchronously once the batch POST returns. Returns an unsubscribe fn.
   */
  request(ref: string, cb: Subscriber): () => void {
    let set = this.subscribers.get(ref);
    if (!set) {
      set = new Set();
      this.subscribers.set(ref, set);
    }
    set.add(cb);

    const cached = this.cache.get(ref);
    if (cached !== undefined) {
      cb(cached);
    } else {
      cb({ status: "loading" });
      this.enqueue(ref);
    }

    return () => {
      const subs = this.subscribers.get(ref);
      if (!subs) return;
      subs.delete(cb);
      if (subs.size === 0) this.subscribers.delete(ref);
    };
  }

  /** Drop cached entries (all, or just given refs) and re-resolve subscribed. */
  invalidate(refs?: string[]): void {
    const targets = refs ?? Array.from(this.cache.keys());
    for (const ref of targets) {
      this.cache.delete(ref);
      const subs = this.subscribers.get(ref);
      if (subs && subs.size > 0) {
        for (const cb of subs) cb({ status: "loading" });
        this.enqueue(ref);
      }
    }
  }

  /** Clear any pending flush timer. Call from `EditorConnection.close()`. */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  private enqueue(ref: string): void {
    this.pending.add(ref);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 0);
  }

  private async flush(): Promise<void> {
    const refs = Array.from(this.pending).filter((r) => !this.cache.has(r));
    this.pending.clear();
    if (refs.length === 0) return;

    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refs }),
      });
      if (!res.ok) return; // leave cache untouched; invalidate can retry
      const json = (await res.json()) as {
        refs?: Record<string, DatasetteStatus>;
      };
      const resolved = json.refs ?? {};
      for (const ref of refs) {
        const status: DatasetteStatus = resolved[ref] ?? { status: "not_found" };
        this.cache.set(ref, status);
        this.notify(ref, status);
      }
    } catch {
      // Swallow: a failed flush must not wedge future flushes. Refs stay
      // uncached, so an invalidate-driven retry can re-fetch them.
    }
  }

  private notify(ref: string, status: DatasetteStatus): void {
    const subs = this.subscribers.get(ref);
    if (!subs) return;
    for (const cb of subs) cb(status);
  }
}
