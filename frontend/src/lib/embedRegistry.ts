/**
 * Public JS API for third-party plugins to render rich datasette embeds.
 *
 * A sibling plugin (e.g. datasette-places) ships a small bundle — injected
 * into the paper editor page by its `paper_resource_provider.frontend_assets`
 * — that calls `window.datasettePaperEmbeds.register({...})` to register a
 * renderer for a backend `kind`. The block embed NodeView
 * (datasetteEmbedView.ts) then delegates rendering of that kind to the
 * registered renderer; the paste handler (datasettePaste.ts) asks renderers
 * to claim pasted URLs via `matchUrl`.
 *
 * The registry lives on `window` so paper and the external bundle (separate
 * builds, arbitrary load order) share one instance. Both create it with the
 * same idempotent shape — keep `Registry` stable; the external side
 * replicates this shim.
 */

export interface PaperEmbedContext {
  /** The stored ref path, e.g. "/-/places/list/5". */
  ref: string;
  /** The backend embed payload (identity for external kinds). */
  payload: Record<string, unknown>;
  /** The node's `mode` attr (default "table"). */
  mode: string;
}

export interface PaperEmbedRenderer {
  /** Backend `kind` this renderer handles (e.g. "place-list"). */
  kind: string;
  /**
   * Optional: claim a pasted same-origin URL, returning the ref path to store
   * (or null). Lets the paste handler turn a `/-/places/list/5` link into an
   * embed without paper hard-coding the plugin's URL scheme.
   */
  matchUrl?(url: URL): string | null;
  /**
   * Mount a rich view into `host`. May return a cleanup fn, called before
   * re-mount (refresh / ref change) and on NodeView destroy.
   */
  mount(host: HTMLElement, ctx: PaperEmbedContext): void | (() => void);
}

export interface PaperEmbedRegistry {
  register(renderer: PaperEmbedRenderer): void;
  get(kind: string): PaperEmbedRenderer | undefined;
  /** First non-null `matchUrl` result across all renderers, else null. */
  match(url: URL): string | null;
  all(): PaperEmbedRenderer[];
}

declare global {
  interface Window {
    datasettePaperEmbeds?: PaperEmbedRegistry;
  }
}

export function makeEmbedRegistry(): PaperEmbedRegistry {
  const byKind: Record<string, PaperEmbedRenderer> = {};
  return {
    register(renderer) {
      byKind[renderer.kind] = renderer;
    },
    get(kind) {
      return byKind[kind];
    },
    match(url) {
      for (const r of Object.values(byKind)) {
        if (r.matchUrl) {
          const ref = r.matchUrl(url);
          if (ref) return ref;
        }
      }
      return null;
    },
    all() {
      return Object.values(byKind);
    },
  };
}

/** The shared registry, created on first access. Returns a standalone one off
 *  the DOM (tests/SSR) so callers never crash. */
export function embedRegistry(): PaperEmbedRegistry {
  if (typeof window === "undefined") return makeEmbedRegistry();
  if (!window.datasettePaperEmbeds) {
    window.datasettePaperEmbeds = makeEmbedRegistry();
  }
  return window.datasettePaperEmbeds;
}
