// @feat highlight: clamp + setHighlight/clearHighlight/toggleHighlight command tests
import { describe, it, expect, beforeEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";

import { schema, clampHighlightColor, HIGHLIGHT_COLORS } from "../schema";
import {
  activeHighlightColor,
  clearHighlight,
  lastHighlightColor,
  resetLastHighlightColor,
  setHighlight,
  toggleHighlight,
} from "../highlight";

function stateWith(doc: PMNode, from: number, to = from): EditorState {
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

const hl = (color: string) => schema.marks.highlight.create({ color });
const para = (...inline: PMNode[]) =>
  schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, inline));

function run(state: EditorState, cmd: typeof clearHighlight): EditorState {
  let next = state;
  cmd(state, (tr) => {
    next = state.apply(tr);
  });
  return next;
}

beforeEach(() => resetLastHighlightColor());

describe("clampHighlightColor", () => {
  it("passes the four slots through", () => {
    for (const c of HIGHLIGHT_COLORS) expect(clampHighlightColor(c)).toBe(c);
  });
  it("clamps unknown / non-string values to hl1", () => {
    for (const bad of ["red", "hl5", "", null, undefined, 2, {}, '"><x>']) {
      expect(clampHighlightColor(bad)).toBe("hl1");
    }
  });
  it("toDOM clamps a bogus color attr", () => {
    const spec = schema.marks.highlight.spec;
    const dom = spec.toDOM!(schema.marks.highlight.create({ color: "evil" }), true);
    expect(dom).toEqual(["mark", { class: "pp-hl", "data-color": "hl1" }, 0]);
  });
});

describe("highlight commands", () => {
  it("setHighlight applies a color over the selection and records it as last-used", () => {
    const s = run(stateWith(para(schema.text("hello")), 1, 6), setHighlight("hl2"));
    expect(activeHighlightColor(s)).toBe("hl2");
    expect(lastHighlightColor()).toBe("hl2");
  });

  it("setHighlight replaces an existing color (one highlight mark per span)", () => {
    const doc = para(schema.text("hello", [hl("hl1")]));
    const s = run(stateWith(doc, 1, 6), setHighlight("hl4"));
    const marks = s.doc.firstChild!.firstChild!.marks;
    expect(marks.map((m) => [m.type.name, m.attrs.color])).toEqual([["highlight", "hl4"]]);
  });

  it("setHighlight on an empty selection sets a stored mark", () => {
    const s = run(stateWith(para(schema.text("hello")), 3), setHighlight("hl3"));
    expect(schema.marks.highlight.isInSet(s.storedMarks ?? [])?.attrs.color).toBe("hl3");
    expect(activeHighlightColor(s)).toBe("hl3");
  });

  it("clearHighlight removes the highlight from the selection", () => {
    const doc = para(schema.text("hello", [hl("hl2"), schema.marks.strong.create()]));
    const s = run(stateWith(doc, 1, 6), clearHighlight);
    expect(s.doc.rangeHasMark(1, 6, schema.marks.highlight)).toBe(false);
    expect(s.doc.rangeHasMark(1, 6, schema.marks.strong)).toBe(true);
    expect(activeHighlightColor(s)).toBeNull();
  });

  it("toggleHighlight removes when present, else applies the last-used color", () => {
    const doc = para(schema.text("hello"));
    run(stateWith(doc, 1, 2), setHighlight("hl3"));
    const on = run(stateWith(doc, 1, 6), toggleHighlight);
    expect(activeHighlightColor(on)).toBe("hl3");
    const off = run(on, toggleHighlight);
    expect(off.doc.rangeHasMark(1, 6, schema.marks.highlight)).toBe(false);
  });
});
