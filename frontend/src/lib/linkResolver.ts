/**
 * LinkResolver — batches paper-link id resolution into a single POST to
 * `/-/paper/api/links/resolve`, caches the results, and notifies per-id
 * subscribers.
 *
 * One resolver lives per editor. ProseMirror NodeViews call `request(id, cb)`
 * to learn a link's title/state, and `unsubscribe()` from `destroy()`. Ids
 * requested within the same tick are coalesced into one POST; resolved
 * statuses are cached so a repeat `request()` for a known id is answered
 * synchronously with no fetch.
 *
 * The POST sends `Content-Type: application/json` — Datasette's `skip_csrf`
 * hook waives CSRF only when that header is present (see `client.ts`).
 */

export type LinkStatus =
  | {
      status: "ok";
      title: string;
      state: "active" | "archived" | "trashed";
      kind: string;
      href: string;
    }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "loading" };

export const RESOLVE_ENDPOINT = "/-/paper/api/links/resolve";

type Subscriber = (status: LinkStatus) => void;

export class LinkResolver {
  private endpoint: string;
  private cache = new Map<number, LinkStatus>();
  private subscribers = new Map<number, Set<Subscriber>>();
  // Ids waiting to be fetched on the next flush.
  private pending = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(endpoint: string = RESOLVE_ENDPOINT) {
    this.endpoint = endpoint;
  }

  /**
   * Register interest in `docId`. Invokes `cb` synchronously with the current
   * best-known status (a cached value, or `{status:"loading"}` if unknown),
   * then again asynchronously with the resolved status once the batch POST
   * returns. Returns an unsubscribe function.
   */
  request(docId: number, cb: Subscriber): () => void {
    let set = this.subscribers.get(docId);
    if (!set) {
      set = new Set();
      this.subscribers.set(docId, set);
    }
    set.add(cb);

    const cached = this.cache.get(docId);
    if (cached !== undefined) {
      cb(cached);
    } else {
      cb({ status: "loading" });
      this.enqueue(docId);
    }

    return () => {
      const subs = this.subscribers.get(docId);
      if (!subs) return;
      subs.delete(cb);
      if (subs.size === 0) this.subscribers.delete(docId);
    };
  }

  /**
   * Drop cached entries (all, or just the given ids) and re-resolve any that
   * currently have subscribers.
   */
  invalidate(ids?: number[]): void {
    const targets = ids ?? Array.from(this.cache.keys());
    for (const id of targets) {
      this.cache.delete(id);
      const subs = this.subscribers.get(id);
      if (subs && subs.size > 0) {
        for (const cb of subs) cb({ status: "loading" });
        this.enqueue(id);
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

  private enqueue(docId: number): void {
    this.pending.add(docId);
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
    // Only fetch ids that are still uncached (a synchronous cache fill could
    // have happened between enqueue and flush).
    const ids = Array.from(this.pending).filter((id) => !this.cache.has(id));
    this.pending.clear();
    if (ids.length === 0) return;

    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        // Leave cache untouched; a later invalidate can retry.
        return;
      }
      const json = (await res.json()) as {
        links?: Record<string, LinkStatus>;
      };
      const links = json.links ?? {};

      for (const id of ids) {
        const value = links[String(id)];
        // Defensive: an id requested but absent from the response resolves to
        // not_found rather than staying "loading" forever.
        const status: LinkStatus = value ?? { status: "not_found" };
        this.cache.set(id, status);
        this.notify(id, status);
      }
    } catch {
      // Swallow: a failed flush must not wedge future flushes or throw. The
      // ids stay uncached, so an invalidate-driven retry can re-fetch them.
    }
  }

  private notify(id: number, status: LinkStatus): void {
    const subs = this.subscribers.get(id);
    if (!subs) return;
    for (const cb of subs) cb(status);
  }
}
