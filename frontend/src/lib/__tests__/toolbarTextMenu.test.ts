/**
 * Text ▾ dropdown label derivation. `blockTypeLabel` is pure over EditorState
 * (the toolbar RAF-tick derives the trigger label from it), so these assertions
 * build minimal docs from schema fixtures and need no DOM / EditorView.
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection, Selection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import { blockTypeLabel } from "../blockTypeLabel";

const { doc, paragraph, heading, blockquote, code_block, callout, callout_title } = schema.nodes;

/** Build a state whose selection sits inside `node`'s first text position. */
function stateWith(node: PMNode): EditorState {
  const d = doc.create(null, [node]);
  return EditorState.create({ doc: d, selection: Selection.atStart(d) });
}

describe("blockTypeLabel", () => {
  it("reports Text for a plain paragraph", () => {
    expect(blockTypeLabel(stateWith(paragraph.create()))).toBe("Text");
  });

  it("reports H1/H2/H3 by heading level", () => {
    expect(blockTypeLabel(stateWith(heading.create({ level: 1 })))).toBe("H1");
    expect(blockTypeLabel(stateWith(heading.create({ level: 2 })))).toBe("H2");
    expect(blockTypeLabel(stateWith(heading.create({ level: 3 })))).toBe("H3");
  });

  it("reports Quote for a paragraph inside a blockquote", () => {
    expect(blockTypeLabel(stateWith(blockquote.create(null, [paragraph.create()])))).toBe("Quote");
  });

  it("reports Callout for a paragraph inside a callout body", () => {
    const c = callout.create({ kind: "note" }, [callout_title.create(), paragraph.create()]);
    // Put the cursor in the body paragraph (skip the title child).
    const d = doc.create(null, [c]);
    const bodyPos = 1 + c.child(0).nodeSize + 1; // into callout > paragraph
    const state = EditorState.create({ doc: d, selection: TextSelection.create(d, bodyPos) });
    expect(blockTypeLabel(state)).toBe("Callout");
  });

  it("reports Code for a code block", () => {
    expect(blockTypeLabel(stateWith(code_block.create()))).toBe("Code");
  });

  it("innermost block wins — a heading inside a blockquote reports the heading", () => {
    expect(blockTypeLabel(stateWith(blockquote.create(null, [heading.create({ level: 2 })])))).toBe(
      "H2",
    );
  });
});
