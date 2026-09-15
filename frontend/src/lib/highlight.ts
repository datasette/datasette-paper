/**
 * Color-highlight commands shared by the toolbar swatch popover and the
 * editor keymap / `==text==` input rule (collab.ts).
 *
 * The "last-used color" is plain module state: it starts at `hl1`, updates
 * whenever a color is applied, and is deliberately not persisted.
 */

import type { Command, EditorState, Transaction } from "prosemirror-state";
import { clampHighlightColor, schema, type HighlightColor } from "./schema";

let lastColor: HighlightColor = "hl1";

/** The color `Mod-Shift-h` and the `==text==` input rule apply. */
export function lastHighlightColor(): HighlightColor {
  return lastColor;
}

/** Test hook — reset the module-level last-used color. */
export function resetLastHighlightColor(): void {
  lastColor = "hl1";
}

/** The highlight color at the selection (stored marks / cursor marks for an
 *  empty selection, the first highlighted text in the range otherwise), or
 *  `null` when nothing is highlighted. */
export function activeHighlightColor(state: EditorState): HighlightColor | null {
  const type = schema.marks.highlight;
  const sel = state.selection;
  if (sel.empty) {
    const mark = type.isInSet(state.storedMarks || sel.$from.marks());
    return mark ? clampHighlightColor(mark.attrs.color) : null;
  }
  // A holder object: TS doesn't track assignments made inside the callback.
  const hit: { color: HighlightColor | null } = { color: null };
  for (const range of sel.ranges) {
    state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node) => {
      if (hit.color) return false;
      const mark = type.isInSet(node.marks);
      if (mark) hit.color = clampHighlightColor(mark.attrs.color);
      return true;
    });
    if (hit.color) break;
  }
  return hit.color;
}

function cursorAllowsHighlight(state: EditorState): boolean {
  return state.selection.$from.parent.type.allowsMarkType(schema.marks.highlight);
}

// @feat highlight: setHighlight/clearHighlight/toggleHighlight commands (toolbar + keymap)
/** Apply `color` over the selection, replacing any existing highlight color.
 *  An empty selection sets the stored mark (like bold). Updates the last-used
 *  color. */
export function setHighlight(color: HighlightColor): Command {
  return (state, dispatch) => {
    const type = schema.marks.highlight;
    const c = clampHighlightColor(color);
    const sel = state.selection;
    if (sel.empty && !cursorAllowsHighlight(state)) return false;
    if (dispatch) {
      lastColor = c;
      const mark = type.create({ color: c });
      let tr: Transaction;
      if (sel.empty) {
        tr = state.tr.removeStoredMark(type).addStoredMark(mark);
      } else {
        tr = state.tr;
        for (const range of sel.ranges) {
          tr.removeMark(range.$from.pos, range.$to.pos, type);
          tr.addMark(range.$from.pos, range.$to.pos, mark);
        }
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Remove any highlight from the selection (or the stored marks). */
export const clearHighlight: Command = (state, dispatch) => {
  const type = schema.marks.highlight;
  const sel = state.selection;
  if (dispatch) {
    let tr: Transaction;
    if (sel.empty) {
      tr = state.tr.removeStoredMark(type);
      // Cursor inside an existing highlight: stored marks = its marks minus
      // the highlight, so typing continues unhighlighted.
      const here = sel.$from.marks();
      if (type.isInSet(here)) tr.setStoredMarks(type.removeFromSet(here));
    } else {
      tr = state.tr;
      for (const range of sel.ranges) tr.removeMark(range.$from.pos, range.$to.pos, type);
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** `Mod-Shift-h`: remove the highlight if the selection has one, else apply
 *  the last-used color. */
export const toggleHighlight: Command = (state, dispatch) =>
  activeHighlightColor(state)
    ? clearHighlight(state, dispatch)
    : setHighlight(lastColor)(state, dispatch);
