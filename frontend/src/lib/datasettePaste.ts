/**
 * Context-aware "drop a link" paste handling for Datasette resource URLs.
 *
 * Pasting a single Datasette URL auto-detects the surface:
 *   - empty paragraph at doc depth 1 → a `block_embed` block
 *   - mid-text (or any nested context) → an inline `inline_embed`
 *   - a bare database URL (`/db`) → always inline (no whole-DB embed in v1)
 * Anything that isn't a Datasette resource path falls through (returns false)
 * so the default paste (plain link) runs.
 *
 * The two decisions are split into pure helpers (`parseDatasetteRef`,
 * `chooseDatasetteSurface`) so they're unit-testable without an EditorView.
 * There is deliberately no typed `{{` trigger — search-driven insertion lives
 * in the `/` slash menu (ticket 09).
 */
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { schema } from "./schema";
import { embedRegistry } from "./embedRegistry";
import { manifestEntryForRef } from "./embedProviders";

export interface RefParseContext {
  /** The page origin, e.g. `window.location.origin`. */
  origin: string;
  /** Datasette `base_url` (default "/"); stripped from the path. */
  baseUrl?: string;
}

/**
 * Parse pasted text into a same-origin URL, or null if it isn't one. Must be a
 * single token that already looks like a URL or absolute path — we never coerce
 * plain words (`new URL("hello", origin)` would otherwise succeed).
 */
function sameOriginUrl(text: string, origin: string): URL | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (!/^(https?:\/\/|\/)/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed, origin);
  } catch {
    return null;
  }
  return url.origin === origin ? url : null;
}

/** The base_url-relative pathname of a same-origin URL, or null. */
function sameOriginPath(text: string, ctx: RefParseContext): string | null {
  const url = sameOriginUrl(text, ctx.origin);
  if (!url) return null;
  let path = url.pathname;
  const base = ctx.baseUrl && ctx.baseUrl !== "/" ? ctx.baseUrl : null;
  if (base && path.startsWith(base)) {
    path = "/" + path.slice(base.length);
  }
  return path;
}

/**
 * Parse pasted text into a Datasette ref path (`/db`, `/db/table`,
 * `/db/table/pk`), or null if it isn't a same-origin Datasette resource URL.
 * The path is returned base_url-relative; table-vs-view is resolved server-side.
 */
export function parseDatasetteRef(
  text: string,
  ctx: RefParseContext,
): string | null {
  const path = sameOriginPath(text, ctx);
  if (path == null) return null;

  const segments = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (segments.length < 1 || segments.length > 3) return null;
  // Datasette tooling / plugin / static paths are not resources.
  if (segments[0].startsWith("-") || segments[0].startsWith("_")) return null;

  return "/" + segments.join("/");
}

/**
 * Ask registered third-party embed providers (the embed registry) to
 * claim a pasted same-origin URL, returning the ref path to store. Lets a
 * plugin like datasette-places turn its own `/-/places/list/5` link into an
 * embed without paper hard-coding that URL scheme. Same-origin only in v1
 * (external-web link cards are a separate, server-side feature).
 */
export function matchExternalRef(text: string, origin: string): string | null {
  const url = sameOriginUrl(text, origin);
  return url ? embedRegistry().match(url) : null;
}

/**
 * Claim a pasted same-origin URL for a provider that is declared in the
 * manifest but whose bundle isn't loaded yet — matched by the URL's
 * base-relative path against the provider's `ref_prefixes`. Returns that path
 * to store as the ref; the NodeView lazy-loads the bundle on render. This is
 * the path-based fallback to `matchExternalRef` (which needs the bundle loaded
 * to run the provider's own `matchUrl`); a provider that transforms URL→ref
 * non-trivially only claims pastes once its bundle is loaded.
 */
export function matchManifestRef(
  text: string,
  ctx: RefParseContext,
): string | null {
  const path = sameOriginPath(text, ctx);
  if (path == null) return null;
  return manifestEntryForRef(path) ? path : null;
}

/** True when the cursor is in an empty top-level paragraph (block surface). */
function isEmptyTopParagraph(state: EditorState): boolean {
  const sel = state.selection;
  if (!sel.empty) return false;
  const $from = sel.$from;
  if ($from.depth !== 1) return false;
  const block = $from.parent;
  if (block.type !== schema.nodes.paragraph) return false;
  return block.content.size === 0;
}

/**
 * Decide whether a pasted ref should become a block embed or an inline ref.
 * Database refs (one segment) are always inline; otherwise an empty top-level
 * paragraph gets a block embed and everything else gets an inline ref.
 */
export function chooseDatasetteSurface(
  state: EditorState,
  ref: string,
): "inline" | "block" {
  const segments = ref.replace(/^\/+/, "").split("/").filter(Boolean);
  if (segments.length <= 1) return "inline"; // database — too large to embed
  return isEmptyTopParagraph(state) ? "block" : "inline";
}

/**
 * EditorView `handlePaste` hook. Returns true to claim the paste (insert a
 * ref/embed), false to let the default paste run.
 */
export function handleDatasettePaste(
  view: EditorView,
  event: ClipboardEvent,
  ctx?: Partial<RefParseContext>,
): boolean {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  const origin = ctx?.origin ?? window.location.origin;
  // Core db/table/row refs first; then a loaded provider's own matchUrl;
  // finally the manifest prefix fallback for a provider not yet loaded.
  const ref =
    parseDatasetteRef(text, { origin, baseUrl: ctx?.baseUrl }) ??
    matchExternalRef(text, origin) ??
    matchManifestRef(text, { origin, baseUrl: ctx?.baseUrl });
  if (ref == null) return false;

  const surface = chooseDatasetteSurface(view.state, ref);
  if (surface === "block") {
    const node = schema.nodes.block_embed.create({ ref, mode: "table" });
    const $from = view.state.selection.$from;
    // Replace the empty paragraph itself with the block.
    const from = $from.before($from.depth);
    const to = $from.after($from.depth);
    view.dispatch(view.state.tr.replaceRangeWith(from, to, node).scrollIntoView());
  } else {
    const node = schema.nodes.inline_embed.create({ ref });
    view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
  }
  return true;
}
