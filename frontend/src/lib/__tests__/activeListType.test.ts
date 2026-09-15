/**
 * List ▾ dropdown active-state derivation. `activeListType` is pure over
 * EditorState (the toolbar RAF-tick derives the trigger's active state and the
 * active-row marker from it), so these assertions build minimal docs from
 * schema fixtures and need no DOM / EditorView.
 */
import { describe, it, expect } from "vitest";
import { EditorState, Selection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import { activeListType } from "../activeListType";

const { doc, paragraph, bullet_list, ordered_list, list_item, task_list, task_item } = schema.nodes;

/** State with the selection at the start of `node`'s first text position. */
function stateAtStart(node: PMNode): EditorState {
  const d = doc.create(null, [node]);
  return EditorState.create({ doc: d, selection: Selection.atStart(d) });
}

const li = (child: PMNode = paragraph.create()) => list_item.create(null, [child]);
const ti = (children: PMNode[] = [paragraph.create()]) => task_item.create(null, children);

describe("activeListType", () => {
  it("returns null for a plain paragraph outside any list", () => {
    expect(activeListType(stateAtStart(paragraph.create()))).toBeNull();
  });

  it("reports bullet_list inside a bullet list", () => {
    expect(activeListType(stateAtStart(bullet_list.create(null, [li()])))).toBe("bullet_list");
  });

  it("reports ordered_list inside a numbered list", () => {
    expect(activeListType(stateAtStart(ordered_list.create(null, [li()])))).toBe("ordered_list");
  });

  it("reports task_list inside a task list", () => {
    expect(activeListType(stateAtStart(task_list.create(null, [ti()])))).toBe("task_list");
  });

  it("innermost wins — a bullet list nested inside a task item reports bullet_list", () => {
    // task_list > task_item > [paragraph, bullet_list > list_item > paragraph]
    const nested = task_list.create(null, [
      ti([paragraph.create(), bullet_list.create(null, [li()])]),
    ]);
    const d = doc.create(null, [nested]);
    // atEnd lands in the last textblock — the inner bullet-list paragraph.
    const state = EditorState.create({ doc: d, selection: Selection.atEnd(d) });
    expect(activeListType(state)).toBe("bullet_list");
  });
});
