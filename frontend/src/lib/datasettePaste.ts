/**
 * Context-aware "drop a link" paste handling for Datasette resource URLs.
 *
 * Pasting a single Datasette URL auto-detects the surface:
 *   - empty paragraph at doc depth 1 → a `datasette_embed` block
 *   - mid-text (or any nested context) → an inline `datasette_ref`
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

export interface RefParseContext {
  /** The page origin, e.g. `window.location.origin`. */
  origin: string;
  /** Datasette `base_url` (default "/"); stripped from the path. */
  baseUrl?: string;
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
  const trimmed = text.trim();
  // Must be a single token that already looks like a URL or absolute path —
  // never coerce plain words (`new URL("hello", origin)` would otherwise).
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (!/^(https?:\/\/|\/)/.test(trimmed)) return null;

  let url: URL;
  try {
    url = new URL(trimmed, ctx.origin);
  } catch {
    return null;
  }
  if (url.origin !== ctx.origin) return null; // external → plain link

  let path = url.pathname;
  const base = ctx.baseUrl && ctx.baseUrl !== "/" ? ctx.baseUrl : null;
  if (base && path.startsWith(base)) {
    path = "/" + path.slice(base.length);
  }

  const segments = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (segments.length < 1 || segments.length > 3) return null;
  // Datasette tooling / plugin / static paths are not resources.
  if (segments[0].startsWith("-") || segments[0].startsWith("_")) return null;

  return "/" + segments.join("/");
}

/**
 * Ask registered third-party embed renderers (window.datasettePaperEmbeds)
 * to claim a pasted same-origin URL, returning the ref path to store. Lets a
 * plugin like datasette-places turn its own `/-/places/list/5` link into an
 * embed without paper hard-coding that URL scheme.
 */
export function matchExternalRef(text: string, origin: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (!/^(https?:\/\/|\/)/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return embedRegistry().match(url);
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
  // Core db/table/row refs first; otherwise let a third-party provider claim it.
  const ref =
    parseDatasetteRef(text, { origin, baseUrl: ctx?.baseUrl }) ??
    matchExternalRef(text, origin);
  if (ref == null) return false;

  const surface = chooseDatasetteSurface(view.state, ref);
  if (surface === "block") {
    const node = schema.nodes.datasette_embed.create({ ref, mode: "table" });
    const $from = view.state.selection.$from;
    // Replace the empty paragraph itself with the block.
    const from = $from.before($from.depth);
    const to = $from.after($from.depth);
    view.dispatch(view.state.tr.replaceRangeWith(from, to, node).scrollIntoView());
  } else {
    const node = schema.nodes.datasette_ref.create({ ref });
    view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
  }
  return true;
}
