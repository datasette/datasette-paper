/**
 * Lazy loader for third-party embed provider bundles.
 *
 * Paper does NOT inject every provider's JS on every doc page. The server emits
 * a manifest (kind / label / asset URLs / ref-prefixes) into the doc page's
 * `page_data`; this module reads it (`setProviderManifest`) and injects a
 * provider's bundle only when the doc needs it:
 *
 *   - render: an embed whose stored ref falls under a provider's `ref_prefixes`
 *     (datasetteResolver / blockEmbedView call `ensureProviderForRef`)
 *   - paste:  a same-origin URL under those prefixes (datasettePaste)
 *   - author: the `/` menu picks the provider's source (slashMenu, #20)
 *
 * Once injected, the bundle calls `window.datasettePaperEmbeds.register({kind})`
 * (see embedRegistry.ts), and the render/resolve paths find it. The registry
 * stays the minimal shared shim; all lazy-load state lives here (paper-only).
 */
import { embedRegistry } from "./embedRegistry";

export interface ProviderManifestEntry {
  /** Stable id; equals the bundle's `register({kind})` call. */
  kind: string;
  /** Human label for the `/` menu (defaults to `kind`). */
  label?: string;
  js?: string[];
  css?: string[];
  /** Stored-ref namespaces this provider owns, e.g. ["/-/places/"]. */
  ref_prefixes?: string[];
}

let manifest: ProviderManifestEntry[] = [];
const injected = new Set<string>(); // asset URLs already appended to <head>
const inflight = new Map<string, Promise<void>>(); // kind → in-flight load

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

/**
 * Ensure provider `kind`'s bundle is injected and registered. Idempotent and
 * de-duped: an already-registered provider resolves immediately; concurrent
 * callers share one in-flight promise. Resolves even if the bundle never
 * registers (after a short grace) so callers degrade rather than hang. A
 * `kind` absent from the manifest is a no-op.
 */
export function ensureProvider(kind: string): Promise<void> {
  if (embedRegistry().get(kind)) return Promise.resolve();
  const existing = inflight.get(kind);
  if (existing) return existing;
  const entry = manifest.find((e) => e.kind === kind);
  if (!entry || typeof document === "undefined") return Promise.resolve();

  const p = injectAssets(entry).then(() => waitForRegister(kind));
  inflight.set(kind, p);
  return p;
}

/** Convenience: load whichever provider (if any) the manifest says owns `ref`. */
export function ensureProviderForRef(ref: string): Promise<void> {
  const kind = manifestKindForRef(ref);
  return kind ? ensureProvider(kind) : Promise.resolve();
}

function injectAssets(entry: ProviderManifestEntry): Promise<void> {
  for (const href of entry.css ?? []) {
    if (injected.has(href)) continue;
    injected.add(href);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }
  const loads = (entry.js ?? []).map((src) => {
    if (injected.has(src)) return Promise.resolve();
    injected.add(src);
    return new Promise<void>((resolve) => {
      const script = document.createElement("script");
      script.src = src;
      // Degrade on error: the render path shows not_found rather than hanging.
      script.onload = () => resolve();
      script.onerror = () => resolve();
      document.head.appendChild(script);
    });
  });
  return Promise.all(loads).then(() => undefined);
}

/**
 * Poll for the bundle's `register({kind})` for a short grace window. A
 * well-behaved bundle registers synchronously as it executes, so by the time
 * the script's `onload` fires the registry already has it; the poll only
 * covers a bundle that registers a tick late.
 */
function waitForRegister(kind: string, tries = 20): Promise<void> {
  if (embedRegistry().get(kind) || tries <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, 25)).then(() =>
    waitForRegister(kind, tries - 1),
  );
}

/** Test-only: clear manifest + injection state between tests. */
export function _resetProvidersForTest(): void {
  manifest = [];
  injected.clear();
  inflight.clear();
}
