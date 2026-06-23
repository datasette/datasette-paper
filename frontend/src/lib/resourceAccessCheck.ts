/**
 * ResourceAccessChecker — the embed analogue of `linkAccessCheck.ts`'s
 * AccessChecker, but keyed by *ref* instead of target doc id and loaded
 * lazily per ref (refs are open-ended — any provider path — so there's no
 * single bulk report to fetch up front).
 *
 * A `datasette_ref` / `datasette_embed` NodeView calls `ensure(ref)` once it
 * knows its ref and subscribes for re-renders; the checker fetches
 * `/-/paper/api/docs/{docId}/resource-access-check?ref=…` and caches the
 * `{gap, missing, open_audience}` answer. The endpoint is EDIT-GATED (403 for
 * non-editors), so a viewer just gets an empty cache (no badges) — after a
 * single 403 we stop fetching entirely.
 *
 * Best-effort authoring aid (06 §#8), never a security control: it reports
 * which *named* collaborators of this doc can't resolve the resource.
 */

import type { AccessGap } from "./linkAccessCheck";

export type { AccessGap };

type Subscriber = () => void;

export class ResourceAccessChecker {
  private docId: string;
  private cache = new Map<string, AccessGap>();
  private inflight = new Set<string>();
  private subscribers = new Set<Subscriber>();
  // Flipped true after the first 403 (non-editor): no point re-fetching any
  // ref, the whole endpoint is gated for this actor.
  private gated = false;

  constructor(docId: string) {
    this.docId = docId;
  }

  /**
   * Kick off the one-shot check for `ref` the first time a NodeView cares.
   * Idempotent per ref; no-op once cached, in flight, or gated. Fire-and-forget.
   */
  ensure(ref: string): void {
    if (!ref || this.gated) return;
    if (this.cache.has(ref) || this.inflight.has(ref)) return;
    this.inflight.add(ref);
    void this.load(ref);
  }

  private async load(ref: string): Promise<void> {
    try {
      const resp = await fetch(
        `/-/paper/api/docs/${this.docId}/resource-access-check?ref=${encodeURIComponent(ref)}`,
      );
      if (resp.status === 403) {
        // Non-editor: gate the whole checker so no further fetches fire.
        this.gated = true;
        return;
      }
      if (!resp.ok) return;
      const json = (await resp.json()) as AccessGap;
      this.cache.set(ref, json);
      this.notify();
    } catch {
      // Swallow network errors: no badge rather than a thrown rejection.
    } finally {
      this.inflight.delete(ref);
    }
  }

  /** The gap report for a ref, or undefined until loaded / gated / absent. */
  get(ref: string): AccessGap | undefined {
    return this.cache.get(ref);
  }

  /** Register to be notified after each check resolves. Returns unsubscribe. */
  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  dispose(): void {
    this.subscribers.clear();
  }

  private notify(): void {
    for (const cb of this.subscribers) cb();
  }
}

/**
 * Build the cross-access affordance for a gap report, or null when there's
 * nothing to flag. `gap` → amber ⚠ warning listing who can't see the
 * resource; `open_audience` (no concrete gap) → a muted · hint that the
 * audience can't be fully enumerated. Mirrors the paper-link badges; callers
 * style via `pm-resource-warn` / `pm-resource-hint`.
 */
export function buildAccessBadge(gap: AccessGap | undefined): HTMLElement | null {
  if (!gap) return null;
  if (gap.gap) {
    const badge = document.createElement("span");
    badge.className = "pm-resource-warn";
    badge.setAttribute(
      "title",
      `Not visible to: ${gap.missing.join(", ")}`,
    );
    badge.textContent = "⚠";
    return badge;
  }
  if (gap.open_audience) {
    const badge = document.createElement("span");
    badge.className = "pm-resource-hint";
    badge.setAttribute(
      "title",
      "This doc may be shared more widely than this resource",
    );
    badge.textContent = "·";
    return badge;
  }
  return null;
}
