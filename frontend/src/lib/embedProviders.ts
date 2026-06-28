/**
 * Lazy loader for third-party embed provider bundles.
 *
 * Paper does NOT load every provider's JS on every doc page. The server emits
 * a manifest (kind / label / asset URLs / ref-prefixes) into the doc page's
 * `page_data`; this module reads it (`setProviderManifest`) and loads a
 * provider's bundle only when the doc needs it:
 *
 *   - render: an embed whose stored ref falls under a provider's `ref_prefixes`
 *     (datasetteResolver / blockEmbedView call `ensureProviderForRef`)
 *   - paste:  a same-origin URL under those prefixes (datasettePaste)
 *   - author: the `/` menu picks the provider's source (slashMenu, #20)
 *
 * A bundle is an **ES module** whose `export default` is a `PaperEmbedProvider`
 * (or an array of them, or a factory returning either). Paper `import()`s the
 * module and registers the provider(s) itself (see embedRegistry.ts) — so the
 * import promise resolving is the readiness signal, with no `<script>` tag, no
 * registration poll, and no shared `window` global. CSS is still a `<link>`.
 */
import { embedRegistry, _resetEmbedRegistryForTest } from "./embedRegistry";
import type { PaperEmbedProvider } from "./embedRegistry";

/** A `/`-menu insert source declared by a provider (mirrors its JS picker()). */
export interface ProviderManifestSource {
  id: string;
  label: string;
  icon?: string;
  mode?: string;
}

export interface ProviderManifestEntry {
  /** Stable id; equals the bundle's default-exported provider `kind`. */
  kind: string;
  /** Human label for the `/` menu (defaults to `kind`). */
  label?: string;
  js?: string[];
  css?: string[];
  /** Stored-ref namespaces this provider owns, e.g. ["/-/places/"]. */
  ref_prefixes?: string[];
  /** Browsable `/`-menu sources this provider contributes. */
  sources?: ProviderManifestSource[];
}

/** A manifest source paired with its owning provider kind (for lazy-load). */
export interface ManifestSource extends ProviderManifestSource {
  kind: string;
}

let manifest: ProviderManifestEntry[] = [];
const injected = new Set<string>(); // asset URLs already loaded (css <link> + js import)
const inflight = new Map<string, Promise<void>>(); // kind → in-flight load

/** A provider bundle's `export default`: a provider, a list, or a factory. */
type ProviderExport =
  | PaperEmbedProvider
  | PaperEmbedProvider[]
  | (() => PaperEmbedProvider | PaperEmbedProvider[]);

type ProviderModule = { default?: ProviderExport };
type ModuleImporter = (url: string) => Promise<ProviderModule>;

const defaultImporter: ModuleImporter = (url) =>
  // Resolve the (root-relative) bundle URL against the *document* origin, not
  // this module's. Datasette serves the provider route; under `dev-with-hmr`
  // this module is served by the Vite dev server on a different origin, so a
  // bare `import("/-/…")` would resolve to Vite (wrong MIME / blocked) instead
  // of Datasette. Absolute URLs pass through `new URL` unchanged; in a normal
  // single-origin build `document.baseURI` is the same origin, so this is a
  // no-op there.
  import(/* @vite-ignore */ new URL(url, document.baseURI).href) as Promise<ProviderModule>;

// Indirection so tests can stub the dynamic import (jsdom can't fetch a real
// bundle URL). Production always uses `defaultImporter`.
let importModule: ModuleImporter = defaultImporter;

/** Test-only: stub the dynamic `import()` of provider bundles. Pass null to
 *  restore the real importer. */
export function _setModuleImporterForTest(fn: ModuleImporter | null): void {
  importModule = fn ?? defaultImporter;
}

/** Install the manifest from `page_data` (once, at editor init). */
export function setProviderManifest(
  entries: ProviderManifestEntry[] | undefined,
): void {
  manifest = Array.isArray(entries) ? entries : [];
}

export function providerManifest(): ProviderManifestEntry[] {
  return manifest;
}

/** The manifest entry whose `ref_prefixes` claims this stored ref, if any. */
export function manifestEntryForRef(
  ref: string,
): ProviderManifestEntry | undefined {
  return manifest.find((e) => (e.ref_prefixes ?? []).some((p) => ref.startsWith(p)));
}

/** The provider `kind` that owns this ref per the manifest, if any. */
export function manifestKindForRef(ref: string): string | undefined {
  return manifestEntryForRef(ref)?.kind;
}

/** All `/`-menu sources across providers, each tagged with its provider kind. */
export function manifestSources(): ManifestSource[] {
  return manifest.flatMap((e) =>
    (e.sources ?? []).map((s) => ({ ...s, kind: e.kind })),
  );
}

/** The provider `kind` that owns this `/`-menu source id, if any. */
export function manifestKindForSource(id: string): string | undefined {
  return manifestSources().find((s) => s.id === id)?.kind;
}

/**
 * One insertable embed source for a picker launcher. The `/` slash menu and
 * the toolbar dropdown both consume `embedInsertSources()` — the single source
 * of truth, so the two entry points can't drift (same labels, same native
 * entry, same provider set + order).
 */
export interface EmbedInsertSource {
  /** Source id passed to the picker; undefined = native Datasette. */
  id?: string;
  label: string;
  /** TOOLBAR_ICONS key; callers fall back to "database" if absent/unknown. */
  icon?: string;
  mode?: string;
}

/** Native Datasette (always first) followed by every manifest provider
 *  source, in manifest order. Synchronous — reads the already-set manifest. */
export function embedInsertSources(): EmbedInsertSource[] {
  return [
    { label: "Datasette embed", icon: "database" }, // native; id undefined
    ...manifestSources().map((s) => ({
      id: s.id,
      label: s.label,
      icon: s.icon,
      mode: s.mode,
    })),
  ];
}

/**
 * Ensure provider `kind`'s bundle is loaded and registered. Idempotent and
 * de-duped: an already-registered provider resolves immediately; concurrent
 * callers share one in-flight promise. A bundle that fails to import (or whose
 * default export is malformed) degrades to a no-op rather than hanging or
 * throwing. A `kind` absent from the manifest is a no-op.
 */
export function ensureProvider(kind: string): Promise<void> {
  if (embedRegistry().get(kind)) return Promise.resolve();
  const existing = inflight.get(kind);
  if (existing) return existing;
  const entry = manifest.find((e) => e.kind === kind);
  if (!entry) return Promise.resolve();

  const p = loadProvider(entry);
  inflight.set(kind, p);
  return p;
}

/** Convenience: load whichever provider (if any) the manifest says owns `ref`. */
export function ensureProviderForRef(ref: string): Promise<void> {
  const kind = manifestKindForRef(ref);
  return kind ? ensureProvider(kind) : Promise.resolve();
}

async function loadProvider(entry: ProviderManifestEntry): Promise<void> {
  injectCss(entry.css);
  for (const url of entry.js ?? []) {
    if (injected.has(url)) continue;
    injected.add(url);
    let mod: ProviderModule;
    try {
      mod = await importModule(url);
    } catch {
      // Degrade: a bundle that fails to import just means the render path shows
      // not_found rather than hanging — never throw into the caller.
      continue;
    }
    registerExport(mod?.default);
  }
}

/** Normalize a bundle's `export default` (provider | array | factory) and
 *  register each well-formed provider. A factory/provider that is malformed or
 *  throws is skipped — one bad bundle can't wedge the editor. */
function registerExport(exported: ProviderExport | undefined): void {
  if (!exported) return;
  let value: PaperEmbedProvider | PaperEmbedProvider[];
  try {
    value = typeof exported === "function" ? exported() : exported;
  } catch {
    return;
  }
  const reg = embedRegistry();
  for (const p of Array.isArray(value) ? value : [value]) {
    if (
      p &&
      typeof p === "object" &&
      typeof p.kind === "string" &&
      typeof p.mount === "function"
    ) {
      reg.register(p);
    }
  }
}

function injectCss(hrefs?: string[]): void {
  if (typeof document === "undefined") return;
  for (const href of hrefs ?? []) {
    if (injected.has(href)) continue;
    injected.add(href);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }
}

/** Test-only: clear manifest + load state (and the shared registry) between
 *  tests, and restore the real module importer. */
export function _resetProvidersForTest(): void {
  manifest = [];
  injected.clear();
  inflight.clear();
  importModule = defaultImporter;
  _resetEmbedRegistryForTest();
}
