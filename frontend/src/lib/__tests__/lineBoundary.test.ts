/**
 * Tests for visual line-boundary cursor motion (Cmd/Home + Left/Right).
 *
 * jsdom has no layout, so `coordsAtPos` / `posAtCoords` are stubbed to model a
 * single visual line: the far-left probe resolves to the line start, the
 * far-right probe to the line end. The load-bearing contract is that every
 * binding *consumes* the key (returns true) — that's what stops Cmd+Left from
 * leaking to the browser's Back shortcut — even when geometry is unavailable.
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "../schema";
// @feat line-boundary: cursor moves to the visual line start/end and the key
// is always consumed (never falls through to browser history navigation).
import { moveToLineBoundary } from "../lineBoundary";

const TEXT = "hello world";
const LINE_START = 1; // just inside the paragraph
const LINE_END = 1 + TEXT.length;

/** A one-paragraph doc with the caret placed at `pos`, mounted in a live view. */
function viewAt(pos: number): EditorView {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text(TEXT)]),
  ]);
  let state = EditorState.create({ doc });
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, pos)),
  );
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const view = new EditorView(mount, { state });
  // jsdom has no layout — give the editor DOM a real 0..100 content box so the
  // command's far-left (≈1) / far-right (≈99) probes are meaningful.
  view.dom.getBoundingClientRect = () =>
    ({ left: 0, right: 100, top: 0, bottom: 10 }) as DOMRect;
  view.coordsAtPos = () => ({ left: 50, right: 50, top: 0, bottom: 10 });
  // Model a single visual line: a left-half probe lands on the line start, a
  // right-half probe on the line end.
  view.posAtCoords = ({ left }) =>
    left < 50 ? { pos: LINE_START, inside: -1 } : { pos: LINE_END, inside: -1 };
  return view;
}

describe("moveToLineBoundary", () => {
  it("moves the caret to the line start and consumes the key", () => {
    const view = viewAt(LINE_END);
    const handled = moveToLineBoundary(-1, false)(
      view.state,
      view.dispatch.bind(view),
      view,
    );
    expect(handled).toBe(true);
    expect(view.state.selection.head).toBe(LINE_START);
    expect(view.state.selection.empty).toBe(true);
    view.destroy();
  });

  it("moves the caret to the line end", () => {
    const view = viewAt(LINE_START);
    moveToLineBoundary(1, false)(view.state, view.dispatch.bind(view), view);
    expect(view.state.selection.head).toBe(LINE_END);
    expect(view.state.selection.empty).toBe(true);
    view.destroy();
  });

  it("extends the selection when `extend` is set, keeping the anchor", () => {
    const view = viewAt(LINE_END);
    moveToLineBoundary(-1, true)(view.state, view.dispatch.bind(view), view);
    const sel = view.state.selection;
    expect(sel.anchor).toBe(LINE_END);
    expect(sel.head).toBe(LINE_START);
    expect(sel.empty).toBe(false);
    view.destroy();
  });

  it("consumes the key even when geometry is unavailable (jsdom bail)", () => {
    const view = viewAt(LINE_START);
    view.coordsAtPos = () => {
      throw new Error("no layout");
    };
    let dispatched = false;
    const handled = moveToLineBoundary(-1, false)(
      view.state,
      () => {
        dispatched = true;
      },
      view,
    );
    expect(handled).toBe(true);
    expect(dispatched).toBe(false);
    view.destroy();
  });
});
