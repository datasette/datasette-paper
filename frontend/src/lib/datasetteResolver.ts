/**
 * DatasetteResolver — resolves an `inline_embed` ref path to a display
 * label/kind for the pill NodeView (inlineEmbedView.ts), caches results, and
 * notifies per-ref subscribers. Mirrors `linkResolver.ts` (which models the
 * `denied`/`not_found` states), keyed by the ref path string.
 *
 * **No custom backend.** Each ref is resolved against Datasette's native JSON
 * API — `/<db>.json`, `/<db>/<table>.json?_size=0`,
 * `/<db>/<table>/<pk>.json` — which enforces the requesting actor's
 * permissions via the `ds_actor` cookie. There is no batch endpoint, so refs
 * requested in one tick fan out to one native GET each (N requests, deduped by
 * the per-ref cache — see todos/datasette-embeds/11). A `403` → `denied`, a
 * `404` → `not_found`; both carry no label (leak guard). A transient failure
 * (network / 5xx) leaves the ref uncached so a later `invalidate` retries.
 *
 * One resolver lives per editor. NodeViews call `request(ref, cb)` and
 * unsubscribe from `destroy()`.
 */
import { refSegments } from "./datasetteEmbed";
import { embedRegistry } from "./embedRegistry";
import { ensureProviderForRef, manifestKindForRef } from "./embedProviders";

export type DatasetteStatus =
  | {
      status: "ok";
      kind: string;
      label: string;
      href: string;
      /** Optional raw inline-`<svg>` markup for the header/pill icon. A
       *  third-party provider may set this to override the kind-derived default
       *  (rendered as-is — trusted plugin JS, see embedIconMarkup). Core refs
       *  leave it unset and get `kindIcon(kind)`. */
      icon?: string;
      db?: string;
      table?: string;
      pk?: string;
      count?: number;
    }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "loading" };

type Subscriber = (status: DatasetteStatus) => void;

/**
 * Resolve a single ref against the native JSON API. Returns the resolved
 * status, or `null` for a transient failure that should NOT be cached (so the
 * pill stays "loading" and an invalidate can retry).
 */
export async function resolveRef(ref: string): Promise<DatasetteStatus | null> {
  // A third-party provider that claims this ref owns its resolution — it
  // fetches its own data (with the viewer's cookie) and applies its own leak
  // discipline. A provider with no `resolve` falls through to a generic
  // ref-labelled pill below. If the owning provider's bundle isn't loaded yet,
  // lazy-inject it (the manifest maps the ref's prefix → provider) and retry.
  let provider = embedRegistry().providerForRef(ref);
  if (!provider && manifestKindForRef(ref)) {
    await ensureProviderForRef(ref);
    provider = embedRegistry().providerForRef(ref);
  }
  if (provider?.resolve) {
    try {
      return await provider.resolve(ref);
    } catch {
      return null; // transient — leave uncached so an invalidate can retry
    }
  }
  if (provider) {
    return { status: "ok", kind: provider.kind, label: ref, href: ref };
  }

  const seg = refSegments(ref);
  if (seg.length < 1 || seg.length > 3) return { status: "not_found" };
  const path = "/" + seg.join("/");
  try {
    if (seg.length === 1) {
      const res = await fetch(`${path}.json`);
      if (res.ok) {
        return { status: "ok", kind: "database", label: seg[0], href: path, db: seg[0] };
      }
      return terminalOrNull(res.status);
    }
    if (seg.length === 2) {
      const res = await fetch(`${path}.json?_size=0&_extra=count`);
      if (res.ok) {
        const j = (await res.json()) as { count?: number | null };
        return {
          status: "ok",
          kind: "table",
          label: seg[1],
          href: path,
          db: seg[0],
          count: typeof j.count === "number" ? j.count : undefined,
        };
      }
      return terminalOrNull(res.status);
    }
    // row
    const res = await fetch(`${path}.json?_shape=array`);
    if (res.ok) {
      return {
        status: "ok",
        kind: "row",
        label: seg[2],
        href: path,
        db: seg[0],
        table: seg[1],
        pk: seg[2],
      };
    }
    return terminalOrNull(res.status);
  } catch {
    return null; // transient — leave uncached
  }
}

/** 403 → denied, 404 → not_found, anything else (5xx, etc.) → transient null. */
function terminalOrNull(status: number | undefined): DatasetteStatus | null {
  if (status === 403) return { status: "denied" };
  if (status === 404) return { status: "not_found" };
  return null;
}

// @feat inline-embed: resolve ref to label/kind via native Datasette JSON, cache+notify
export class DatasetteResolver {
  private resolve: (ref: string) => Promise<DatasetteStatus | null>;
  private cache = new Map<string, DatasetteStatus>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(resolve: (ref: string) => Promise<DatasetteStatus | null> = resolveRef) {
    this.resolve = resolve;
  }

  /**
   * Register interest in `ref`. Invokes `cb` synchronously with the current
   * best-known status (cached, or `{status:"loading"}`), then again
   * asynchronously once the native lookup returns. Returns an unsubscribe fn.
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
    // One native lookup per ref (no batch endpoint), all in flight at once.
    await Promise.all(refs.map((ref) => this.resolveOne(ref)));
  }

  private async resolveOne(ref: string): Promise<void> {
    const status = await this.resolve(ref);
    // null = transient failure: leave uncached so an invalidate can retry.
    if (status === null) return;
    this.cache.set(ref, status);
    this.notify(ref, status);
  }

  private notify(ref: string, status: DatasetteStatus): void {
    const subs = this.subscribers.get(ref);
    if (!subs) return;
    for (const cb of subs) cb(status);
  }
}
