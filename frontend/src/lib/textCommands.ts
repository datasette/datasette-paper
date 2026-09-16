/**
 * Inline / block-type commands shared by the two formatting surfaces: the
 * docked strip (`Toolbar.svelte`) and the floating selection bubble
 * (`selectionBubble.ts`).
 *
 * These lived as locals inside `Toolbar.svelte` until the bubble needed the
 * same three (`setHeading`, `toggleLink`, `startWikiLink`). Re-deriving them in
 * a vanilla-DOM plugin view would drift on the first tweak — the same
 * anti-drift argument that moved the shared `.tb-*` shell into `editor.css` —
 * so they moved here instead. `markActive` / `nodeActive` came along because
 * `setHeading`'s toggle is defined in terms of `nodeActive`, and both surfaces
 * need them to paint pressed state.
 *
 * Everything is a ProseMirror `Command` over `(state, dispatch)`, so each
 * surface can run it through its own `run()` helper (which supplies
 * `view.dispatch` and restores editor focus afterwards) rather than reaching
 * for an `EditorView`. `toggleLink` is the one with a user-visible side effect
 * — it asks for the URL with `window.prompt` — and it does so ONLY inside the
 * `dispatch` branch (the prosemirror-menu convention), so probing it with
 * `cmd(state)` to decide whether a button is enabled never pops a dialog.
 */

import { setBlockType, toggleMark } from "prosemirror-commands";
import type { Command, EditorState } from "prosemirror-state";
import type { MarkType, NodeType } from "prosemirror-model";
import { schema } from "./schema";

/**
 * Is `type` active at the selection? An empty selection consults the stored
 * marks (so a just-pressed ⌘B reads as on before anything is typed); a range
 * requires the mark across the whole range.
 */
export function markActive(state: EditorState, type: MarkType): boolean {
  const sel = state.selection;
  if (sel.empty) {
    return !!type.isInSet(state.storedMarks || sel.$from.marks());
  }
  return state.doc.rangeHasMark(sel.from, sel.to, type);
}

/**
 * Is the *innermost* node at the selection head a `type` node whose attrs match
 * `attrs`? Deliberately innermost-only (not an ancestor walk): a heading inside
 * a quote reports the heading, which is what the block-type toggles below and
 * the two toolbars' pressed states want.
 */
export function nodeActive(
  state: EditorState,
  type: NodeType,
  attrs: Record<string, unknown> = {},
): boolean {
  const sel = state.selection;
  const node = sel.$from.node(sel.$from.depth);
  if (node.type !== type) return false;
  return Object.entries(attrs).every(([k, v]) => node.attrs[k] === v);
}

/**
 * Turn the block into a heading at `level` — or back into a paragraph when it
 * already is that heading. The toggle-back leg is what makes "Text" reachable
 * from an H5 that has no menu row of its own, and it keys off `nodeActive`
 * against the innermost node so a heading nested in a quote/callout toggles
 * itself rather than its wrapper.
 */
export function setHeading(level: number): Command {
  return (state, dispatch) =>
    nodeActive(state, schema.nodes.heading, { level })
      ? setBlockType(schema.nodes.paragraph)(state, dispatch)
      : setBlockType(schema.nodes.heading, { level })(state, dispatch);
}

/**
 * Link the selection: strip an existing link mark, otherwise prompt for a URL
 * and apply one. Returns false (a no-op) on an empty selection and when the
 * prompt is dismissed — callers run it through their `run()` helper, which
 * restores editor focus either way.
 *
 * The prompt sits inside the `dispatch` guard on purpose; see the module
 * docstring.
 */
export const toggleLink: Command = (state, dispatch) => {
  const linkType = schema.marks.link;
  const { from, to, empty } = state.selection;
  if (empty) return false;
  if (state.doc.rangeHasMark(from, to, linkType)) {
    return toggleMark(linkType)(state, dispatch);
  }
  if (!dispatch) return true;
  const href = window.prompt("Link URL");
  if (!href) return false;
  return toggleMark(linkType, { href })(state, dispatch);
};

/**
 * Insert `[[` at the cursor to launch the wiki-link autocomplete. The
 * wikiLinkSuggest plugin recomputes from doc+selection on every transaction
 * (no dedicated open command), so a plain insert trips its trigger exactly
 * like typing the brackets by hand.
 */
export const startWikiLink: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.insertText("[["));
  return true;
};
