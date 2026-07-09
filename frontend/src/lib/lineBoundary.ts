/**
 * Visual line-boundary cursor motion for Cmd/Home + Left/Right.
 *
 * ProseMirror binds neither `Mod-ArrowLeft/Right` nor `Home/End`, leaning on
 * the browser's native "move to beginning/end of line" for a contenteditable.
 * That native path breaks in Chromium when a visual line *begins* with an
 * `<a href>` link mark: the browser can't place the caret before the leading
 * link, doesn't consume the keystroke, and Cmd+Left then triggers the
 * window-level Back shortcut — silently navigating away from the doc. (A line
 * with no leading link works fine, which is why the bug looks selective.)
 *
 * So we own line-boundary motion outright. `moveToLineBoundary` reads the
 * caret's screen coords, then asks ProseMirror for the position at the far
 * left/right edge of that same visual line (`posAtCoords` clamps to the
 * nearest position, so a far-off x lands exactly on the line's start/end).
 * This respects soft-wrapped lines — the boundary is the wrap point, not the
 * textblock start/end. Crucially it always returns `true`, so the keystroke
 * never falls through to the browser's history navigation.
 *
 * Geometry needs a laid-out DOM, so in jsdom (`coordsAtPos` unimplemented)
 * the command bails to a no-op that still consumes the key.
 */

import { TextSelection, type Command } from "prosemirror-state";

/**
 * @feat line-boundary: move the caret (or extend the selection) to the visual
 * start (`dir === -1`) or end (`dir === 1`) of the current line. `extend`
 * keeps the anchor fixed (Shift+Cmd+Arrow selection). Always consumes the key.
 */
export function moveToLineBoundary(dir: -1 | 1, extend: boolean): Command {
  return (state, dispatch, view) => {
    if (!view || !dispatch) return false;
    const { selection } = state;
    let caret;
    try {
      caret = view.coordsAtPos(selection.head);
    } catch {
      // Position not rendered (mid-teardown) or geometry unavailable (jsdom).
      // Consume the key anyway so it never leaks to the browser's Back.
      return true;
    }
    const domRect = (view.dom as HTMLElement).getBoundingClientRect();
    // Aim just inside the content box's left/right edge, on the caret's own
    // line. posAtCoords clamps to the nearest position → the visual line
    // start/end. The +1/-1 keeps the probe off the exact border.
    const left = dir < 0 ? domRect.left + 1 : domRect.right - 1;
    const top = (caret.top + caret.bottom) / 2;
    const found = view.posAtCoords({ left, top });
    if (!found) return true;
    let head = found.pos;
    // `posAtCoords` probes the editor's far-left/right *content* edge. For an
    // indented block — a list item, whose bullet sits in the list's left
    // padding — that x lands in the gutter, and Chromium resolves it to a
    // position OUTSIDE the caret's textblock: the `list_item` boundary just
    // before its paragraph. Moving the caret there and typing splits the item
    // into two paragraphs (the reported bug). A visual line never spans more
    // than one textblock, so clamp the boundary into the caret's own textblock.
    const $head = selection.$head;
    if ($head.parent.inlineContent) {
      head = Math.min($head.end(), Math.max($head.start(), head));
    }
    const anchor = extend ? selection.anchor : head;
    const next = TextSelection.create(state.doc, anchor, head);
    // No-op at an existing boundary — still return true to swallow the key.
    if (!next.eq(selection)) {
      dispatch(state.tr.setSelection(next).scrollIntoView());
    }
    return true;
  };
}

// Same platform sniff prosemirror-keymap uses to expand `Mod`. navigator is
// absent under SSR/tests → treat as non-mac.
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iP(hone|[oa]d)/.test(navigator.platform);

/**
 * Keymap for line-boundary motion. Registered ahead of `baseKeymap` so it
 * wins; every binding consumes its key, so nothing leaks to the browser.
 *
 * Home/End mean "line boundary" on every platform, so they're always bound.
 * The Cmd+Arrow bindings are Mac-only: that's where Cmd+Left is "line start"
 * (and, on failure, the Back shortcut). On Windows/Linux the Mod key is Ctrl
 * and Ctrl+Left means *word* motion — binding it here would wrongly hijack
 * that, so we leave those to the browser.
 */
export function lineBoundaryKeymap(): Record<string, Command> {
  const keys: Record<string, Command> = {
    Home: moveToLineBoundary(-1, false),
    End: moveToLineBoundary(1, false),
    "Shift-Home": moveToLineBoundary(-1, true),
    "Shift-End": moveToLineBoundary(1, true),
  };
  if (IS_MAC) {
    keys["Mod-ArrowLeft"] = moveToLineBoundary(-1, false);
    keys["Mod-ArrowRight"] = moveToLineBoundary(1, false);
    keys["Shift-Mod-ArrowLeft"] = moveToLineBoundary(-1, true);
    keys["Shift-Mod-ArrowRight"] = moveToLineBoundary(1, true);
  }
  return keys;
}
