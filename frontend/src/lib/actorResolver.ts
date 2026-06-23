/**
 * ActorResolver — batches actor-id resolution into a single POST to
 * `/-/paper/api/actors/resolve`, caches the results, and notifies per-id
 * subscribers.
 *
 * One resolver lives per editor. The `mention` NodeView calls
 * `request(actorId, cb)` to learn an actor's display name (+ avatar), and
 * `unsubscribe()` from `destroy()`. Ids requested within the same tick are
 * coalesced into one POST; resolved statuses are cached so a repeat
 * `request()` for a known id is answered synchronously with no fetch.
 *
 * Unlike LinkResolver there is no denied / not_found state: the backend
 * always resolves every requested id (falling back to the id itself as the
 * name), so an actor is either `loading` or resolved.
 *
 * The POST sends `Content-Type: application/json` — Datasette's `skip_csrf`
 * hook waives CSRF only when that header is present (see `client.ts`).
 */

export type ActorStatus =
  | { status: "ok"; name: string; avatarUrl: string | null }
  | { status: "loading" };

export const RESOLVE_ENDPOINT = "/-/paper/api/actors/resolve";

type Subscriber = (status: ActorStatus) => void;

export class ActorResolver {
  private endpoint: string;
  private cache = new Map<string, ActorStatus>();
  private subscribers = new Map<string, Set<Subscriber>>();
  // Ids waiting to be fetched on the next flush.
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(endpoint: string = RESOLVE_ENDPOINT) {
    this.endpoint = endpoint;
  }

  /**
   * Register interest in `actorId`. Invokes `cb` synchronously with the
   * current best-known status (a cached value, or `{status:"loading"}` if
   * unknown), then again asynchronously with the resolved status once the
   * batch POST returns. Returns an unsubscribe function.
   */
  request(actorId: string, cb: Subscriber): () => void {
    let set = this.subscribers.get(actorId);
    if (!set) {
      set = new Set();
      this.subscribers.set(actorId, set);
    }
    set.add(cb);

    const cached = this.cache.get(actorId);
    if (cached !== undefined) {
      cb(cached);
    } else {
      cb({ status: "loading" });
      this.enqueue(actorId);
    }

    return () => {
      const subs = this.subscribers.get(actorId);
      if (!subs) return;
      subs.delete(cb);
      if (subs.size === 0) this.subscribers.delete(actorId);
    };
  }

  /**
   * Drop cached entries (all, or just the given ids) and re-resolve any that
   * currently have subscribers.
   */
  invalidate(ids?: string[]): void {
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

  private enqueue(actorId: string): void {
    this.pending.add(actorId);
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
        actors?: Record<string, { name: string; avatar_url: string | null }>;
      };
      const actors = json.actors ?? {};

      for (const id of ids) {
        const value = actors[id];
        // Defensive: the backend resolves every requested id, but if one is
        // absent fall back to the id itself rather than staying "loading".
        const status: ActorStatus = value
          ? { status: "ok", name: value.name, avatarUrl: value.avatar_url }
          : { status: "ok", name: id, avatarUrl: null };
        this.cache.set(id, status);
        this.notify(id, status);
      }
    } catch {
      // Swallow: a failed flush must not wedge future flushes or throw. The
      // ids stay uncached, so an invalidate-driven retry can re-fetch them.
    }
  }

  private notify(id: string, status: ActorStatus): void {
    const subs = this.subscribers.get(id);
    if (!subs) return;
    for (const cb of subs) cb(status);
  }
}
