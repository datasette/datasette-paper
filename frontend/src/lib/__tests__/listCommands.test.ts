/**
 * `indentListSelection` / `dedentListSelection` (listCommands.ts): the shared
 * task-aware indent pair behind Tab / Shift-Tab, `Mod-]` / `Mod-[` and the
 * Toolbar List ▾ rows. Pure EditorState — no view.
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../schema";
import { indentListSelection, dedentListSelection } from "../listCommands";
import type { Command } from "prosemirror-state";

const n = schema.nodes;
const p = (text: string) => n.paragraph.create(null, schema.text(text));

function stateAtB(doc: PMNode): EditorState {
  let pos = -1;
  doc.descendants((node, at) => {
    if (pos === -1 && node.isText && node.text === "b") pos = at + 1;
  });
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}

function run(state: EditorState, cmd: Command): EditorState {
  let next = state;
  const ok = cmd(state, (tr) => {
    next = state.apply(tr);
  });
  expect(ok).toBe(true);
  return next;
}

describe("listCommands", () => {
  const cases: [string, PMNode][] = [
    [
      "bullet list",
      n.bullet_list.create(null, [n.list_item.create(null, p("a")), n.list_item.create(null, p("b"))]),
    ],
    [
      // current model (task_item); list-kinds 05 updates
      "task list",
      n.task_list.create(null, [n.task_item.create(null, p("a")), n.task_item.create(null, p("b"))]),
    ],
  ];

  for (const [name, list] of cases) {
    it(`indent then dedent restores the doc (${name})`, () => {
      const doc = n.doc.create(null, [list]);
      const start = stateAtB(doc);
      const indented = run(start, indentListSelection);
      expect(indented.doc.eq(doc)).toBe(false);
      expect(indented.doc.firstChild!.childCount).toBe(1);
      const restored = run(indented, dedentListSelection);
      expect(restored.doc.eq(doc)).toBe(true);
    });
  }

  it("both decline outside a list", () => {
    const doc = n.doc.create(null, [p("b")]);
    const state = stateAtB(doc);
    expect(indentListSelection(state)).toBe(false);
    expect(dedentListSelection(state)).toBe(false);
  });
});
