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
  /**
   * The block node's `config` attr — a provider-defined bag (e.g. column
   * selection, sort) carried through the markdown `paper-embed` fence.
   * Opaque to core paper; default `{}`.
   */
  config: Record<string, unknown>;
}

/** A browsable insert source a provider contributes to the `/` slash menu. */
export interface PaperEmbedSource {
  /** Stable id; must not be "datasette" (the reserved core source). */
  id: string;
  /** Menu label, e.g. "Places map". */
  label: string;
  /** Optional TOOLBAR_ICONS key for the menu + dialog. */
  icon?: string;
  /** Default `mode` stored on the inserted block (provider-specific). */
  mode?: string;
}

/** One search hit a provider returns for its picker dialog. */
export interface EmbedSearchResult {
  /** A ref path this provider `claims` (so it round-trips through `resolve`). */
  ref: string;
  /** Primary display label. */
  label: string;
  /** Optional kind tag shown beside the label. */
  kind?: string;
  /** Optional secondary line, e.g. "12 places". */
  detail?: string;
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
  /**
   * Opt this provider into the editor's `/` insert menu as a named, browsable
   * source. Presence adds a slash command that opens a search dialog scoped to
   * this provider. Requires `search` to be useful.
   */
  picker?(): PaperEmbedSource;
  /**
   * Resources the actor can see whose name matches `q`, for the picker dialog.
   * Permission-filter to the viewer; never list a resource they can't see
   * (same leak discipline as `resolve`).
   */
  search?(q: string, limit: number): Promise<EmbedSearchResult[]>;
}

export interface PaperEmbedRegistry {
  register(provider: PaperEmbedProvider): void;
  /** Look up a provider by its `kind`. */
  get(kind: string): PaperEmbedProvider | undefined;
  /** First provider whose `matchRef(ref)` is true, else undefined. */
  providerForRef(ref: string): PaperEmbedProvider | undefined;
  /** First provider whose `picker().id` equals `id`, else undefined. */
  providerForSource(id: string): PaperEmbedProvider | undefined;
  /** Pickable sources across all providers (those that implement `picker`). */
  sources(): PaperEmbedSource[];
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
    providerForSource(id) {
      // "datasette" is the reserved core source — never a provider.
      if (id === "datasette") return undefined;
      for (const p of Object.values(byKind)) {
        if (p.picker?.().id === id) return p;
      }
      return undefined;
    },
    sources() {
      const out: PaperEmbedSource[] = [];
      const seen = new Set<string>(["datasette"]); // core id is reserved
      for (const p of Object.values(byKind)) {
        const s = p.picker?.();
        if (s && !seen.has(s.id)) {
          seen.add(s.id);
          out.push(s);
        }
      }
      return out;
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
