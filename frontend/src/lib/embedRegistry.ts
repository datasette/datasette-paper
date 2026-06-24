/**
 * Public JS API for third-party plugins to render rich datasette embeds.
 *
 * Since the embed feature reads Datasette's native browser JSON API directly
 * (no paper backend resolve/render — see datasetteEmbed.ts), a third-party
 * provider is **entirely client-side**: a sibling plugin (e.g. datasette-places)
 * ships a small **ES module** whose `export default` is a provider object (or a
 * factory returning one — see embedProviders.ts). Paper's lazy loader
 * `import()`s that module on demand and registers the provider, which supplies
 * both the inline-pill identity (`resolve`) and the block-card body (`mount`).
 * The provider fetches its own data from its own endpoints with the viewer's
 * `ds_actor` cookie, so per-viewer permissions + leak discipline are the
 * provider's responsibility, exactly as for core refs.
 *
 *   inline pill (inline_embed) → datasetteResolver delegates to `resolve(ref)`
 *   block card  (block_embed)  → blockEmbedView delegates to `mount(host)`
 *   paste of a same-origin URL → datasettePaste asks `match(url)` to claim it
 *
 * The registry is a paper-internal singleton (this module). Providers never
 * touch it directly — paper imports a bundle and calls `register()` itself — so
 * there is no shared `window` global and no cross-build load-order problem: the
 * import promise resolving *is* the readiness signal.
 */
import type { DatasetteStatus } from "./datasetteResolver";

export interface PaperEmbedContext {
  /** The stored ref path the provider claimed, e.g. "/-/places/list/5". */
  ref: string;
  /** The block node's `mode` attr (default "table"). */
  mode: string;
}

export interface PaperEmbedProvider {
  /**
   * Stable namespace id for this provider (e.g. "place-list"). Used as the
   * registry key; a second `register` with the same kind replaces the first.
   */
  kind: string;
  /**
   * Does this provider own this stored ref path? Checked before paper's
   * native `.json` resolution, so a provider claims its own URL namespace
   * (e.g. `/-/places/list/...`) without paper hard-coding it. Core db/table/
   * row refs are left unclaimed and fall through to the native path.
   */
  matchRef?(ref: string): boolean;
  /**
   * Claim a pasted same-origin URL, returning the ref path to store (or null).
   * Lets a plugin turn its own `/-/places/list/5` link into an embed on paste.
   */
  matchUrl?(url: URL): string | null;
  /**
   * Inline-pill identity for a claimed ref. Return an `ok` status with
   * label/icon/href, or `denied`/`not_found` (NEVER a label on those — the
   * same leak discipline core refs follow). Return `null` for a transient
   * failure so the pill stays "loading" and a later invalidate retries.
   * A provider that omits `resolve` gets a generic ref-labelled pill.
   */
  resolve?(ref: string): Promise<DatasetteStatus | null>;
  /**
   * Mount a rich block view into `host` (paper owns the surrounding header:
   * icon + label link + refresh + ⋮ menu). May return a cleanup fn, called
   * before re-mount (refresh / ref change) and on NodeView destroy.
   */
  mount(host: HTMLElement, ctx: PaperEmbedContext): void | (() => void);
}

export interface PaperEmbedRegistry {
  register(provider: PaperEmbedProvider): void;
  /** Look up a provider by its `kind`. */
  get(kind: string): PaperEmbedProvider | undefined;
  /** First provider whose `matchRef(ref)` is true, else undefined. */
  providerForRef(ref: string): PaperEmbedProvider | undefined;
  /** First non-null `matchUrl` result across all providers, else null. */
  match(url: URL): string | null;
  all(): PaperEmbedProvider[];
}

export function makeEmbedRegistry(): PaperEmbedRegistry {
  const byKind: Record<string, PaperEmbedProvider> = {};
  return {
    register(provider) {
      byKind[provider.kind] = provider;
    },
    get(kind) {
      return byKind[kind];
    },
    providerForRef(ref) {
      for (const p of Object.values(byKind)) {
        if (p.matchRef?.(ref)) return p;
      }
      return undefined;
    },
    match(url) {
      for (const p of Object.values(byKind)) {
        if (p.matchUrl) {
          const ref = p.matchUrl(url);
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

/** The shared paper-internal registry, created on first access. */
let singleton: PaperEmbedRegistry | undefined;

export function embedRegistry(): PaperEmbedRegistry {
  if (!singleton) singleton = makeEmbedRegistry();
  return singleton;
}

/** Test-only: drop the shared registry so each test starts from empty. */
export function _resetEmbedRegistryForTest(): void {
  singleton = undefined;
}
