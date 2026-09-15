/**
 * List ▾ Toggle-list row active-state derivation. `activeListItemKind` is pure
 * over EditorState (the toolbar RAF-tick derives the row's active marker from
 * it), so these assertions build minimal docs from schema fixtures and need no
 * DOM / EditorView. Companion to activeListType.test.ts — that one reports the
 * container, this one the item.
 */
import { describe, it, expect } from "vitest";
import { EditorState, Selection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import { activeListItemKind } from "../activeListItemKind";

const { doc, paragraph, bullet_list, ordered_list, list_item, task_list, task_item } = schema.nodes;

/** State with the selection at the start of `node`'s first text position. */
function stateAtStart(node: PMNode): EditorState {
  const d = doc.create(null, [node]);
  return EditorState.create({ doc: d, selection: Selection.atStart(d) });
}

const li = (attrs: Record<string, unknown> | null = null, children: PMNode[] = [paragraph.create()]) =>
  list_item.create(attrs, children);

describe("activeListItemKind", () => {
  it("returns null outside any list", () => {
    expect(activeListItemKind(stateAtStart(paragraph.create()))).toBeNull();
  });

  it("returns null inside a task_item (no list_item ancestor)", () => {
    const list = task_list.create(null, [task_item.create(null, [paragraph.create()])]);
    expect(activeListItemKind(stateAtStart(list))).toBeNull();
  });

  it("reports bullet for a plain list item", () => {
    expect(activeListItemKind(stateAtStart(bullet_list.create(null, [li()])))).toBe("bullet");
  });

  it("reports toggle for a toggle item, in a bullet or an ordered list", () => {
    const toggle = li({ kind: "toggle", collapsed: false });
    expect(activeListItemKind(stateAtStart(bullet_list.create(null, [toggle])))).toBe("toggle");
    expect(activeListItemKind(stateAtStart(ordered_list.create(null, [toggle])))).toBe("toggle");
  });

  it("clamps an unknown kind to bullet rather than leaking it to the UI", () => {
    expect(activeListItemKind(stateAtStart(bullet_list.create(null, [li({ kind: "todo" })])))).toBe(
      "bullet",
    );
  });

  it("innermost wins — a bullet nested inside a toggle reports bullet", () => {
    const nested = bullet_list.create(null, [
      li({ kind: "toggle", collapsed: false }, [
        paragraph.create(),
        bullet_list.create(null, [li()]),
      ]),
    ]);
    const d = doc.create(null, [nested]);
    // atEnd lands in the last textblock — the nested item's paragraph.
    const state = EditorState.create({ doc: d, selection: Selection.atEnd(d) });
    expect(activeListItemKind(state)).toBe("bullet");
  });
});
