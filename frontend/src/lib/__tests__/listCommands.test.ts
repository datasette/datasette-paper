/**
 * listCommands.ts: the shared task-aware indent pair behind Tab / Shift-Tab,
 * `Mod-]` / `Mod-[` and the Toolbar List ▾ rows, plus the toggle-list
 * kind / collapse commands behind `/toggle` and the List ▾ Toggle-list row.
 * Pure EditorState — no view.
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../schema";
import {
  indentListSelection,
  dedentListSelection,
  setListItemKind,
  toggleListItemCollapsed,
} from "../listCommands";
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

// ─── toggle-list: setListItemKind / toggleListItemCollapsed ─────────────────

/** Position just inside the text node whose content is `text`. */
function posOf(doc: PMNode, text: string): number {
  let pos = -1;
  doc.descendants((node, at) => {
    if (pos === -1 && node.isText && node.text === text) pos = at + 1;
  });
  expect(pos, `text "${text}"`).toBeGreaterThan(-1);
  return pos;
}

function stateAt(doc: PMNode, text: string): EditorState {
  return EditorState.create({ doc, selection: TextSelection.create(doc, posOf(doc, text)) });
}

/** Selection spanning from inside `from`'s text to inside `to`'s. */
function stateAcross(doc: PMNode, from: string, to: string): EditorState {
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, posOf(doc, from), posOf(doc, to)),
  });
}

const item = (text: string, attrs: Record<string, unknown> | null = null, extra: PMNode[] = []) =>
  n.list_item.create(attrs, [p(text), ...extra]);

describe("setListItemKind", () => {
  it("converts the bullet item at the cursor to a toggle", () => {
    const doc = n.doc.create(null, [n.bullet_list.create(null, [item("a"), item("b")])]);
    const next = run(stateAt(doc, "b"), setListItemKind("toggle"));
    const list = next.doc.firstChild!;
    expect(list.type.name).toBe("bullet_list");
    expect(list.child(0).attrs.kind).toBe("bullet");
    expect(list.child(1).attrs.kind).toBe("toggle");
    expect(list.child(1).attrs.collapsed).toBe(false);
  });

  it("converts every item whose own paragraph the selection touches", () => {
    const doc = n.doc.create(null, [
      n.bullet_list.create(null, [item("a"), item("b"), item("c")]),
    ]);
    const next = run(stateAcross(doc, "a", "b"), setListItemKind("toggle"));
    const list = next.doc.firstChild!;
    expect(list.child(0).attrs.kind).toBe("toggle");
    expect(list.child(1).attrs.kind).toBe("toggle");
    // Untouched by the selection — stays a bullet.
    expect(list.child(2).attrs.kind).toBe("bullet");
  });

  it("leaves a nested child alone when only the parent's paragraph is selected", () => {
    const child = n.bullet_list.create(null, [item("child")]);
    const doc = n.doc.create(null, [
      n.bullet_list.create(null, [item("parent", null, [child])]),
    ]);
    const next = run(stateAt(doc, "parent"), setListItemKind("toggle"));
    const parent = next.doc.firstChild!.child(0);
    expect(parent.attrs.kind).toBe("toggle");
    expect(parent.child(1).child(0).attrs.kind).toBe("bullet");
  });

  it("wraps a plain paragraph in a bullet_list first, in one transaction", () => {
    const doc = n.doc.create(null, [p("b")]);
    const state = stateAt(doc, "b");
    let steps = 0;
    let next = state;
    expect(
      setListItemKind("toggle")(state, (tr) => {
        steps = tr.steps.length;
        next = state.apply(tr);
      }),
    ).toBe(true);
    // One transaction (hence one undo step) covering wrap + retype.
    expect(steps).toBeGreaterThan(1);
    const list = next.doc.firstChild!;
    expect(list.type.name).toBe("bullet_list");
    expect(list.child(0).attrs.kind).toBe("toggle");
    expect(list.child(0).firstChild!.textContent).toBe("b");
  });

  it("retypes an enclosing ordered_list to a bullet_list", () => {
    const doc = n.doc.create(null, [n.ordered_list.create(null, [item("a"), item("b")])]);
    const next = run(stateAt(doc, "b"), setListItemKind("toggle"));
    const list = next.doc.firstChild!;
    expect(list.type.name).toBe("bullet_list");
    expect(list.childCount).toBe(2);
    expect(list.child(0).attrs.kind).toBe("bullet");
    expect(list.child(1).attrs.kind).toBe("toggle");
    expect(list.child(1).firstChild!.textContent).toBe("b");
  });

  it("converting back to a bullet resets collapsed", () => {
    const doc = n.doc.create(null, [
      n.bullet_list.create(null, [
        item("b", { kind: "toggle", collapsed: true }, [
          n.bullet_list.create(null, [item("child")]),
        ]),
      ]),
    ]);
    const next = run(stateAt(doc, "b"), setListItemKind("bullet"));
    const converted = next.doc.firstChild!.child(0);
    expect(converted.attrs.kind).toBe("bullet");
    // A bullet has no chevron, so a still-collapsed subtree could never be
    // reopened.
    expect(converted.attrs.collapsed).toBe(false);
  });

  it("converting back to a bullet leaves an ordered container alone", () => {
    const doc = n.doc.create(null, [
      n.ordered_list.create(null, [item("b", { kind: "toggle", collapsed: false })]),
    ]);
    const next = run(stateAt(doc, "b"), setListItemKind("bullet"));
    expect(next.doc.firstChild!.type.name).toBe("ordered_list");
  });

  it("is enabled in a paragraph (it wraps) and declines in a code_block", () => {
    const para = n.doc.create(null, [p("b")]);
    expect(setListItemKind("toggle")(stateAt(para, "b"))).toBe(true);
    const code = n.doc.create(null, [n.code_block.create(null, schema.text("b"))]);
    expect(setListItemKind("toggle")(stateAt(code, "b"))).toBe(false);
  });
});

describe("toggleListItemCollapsed", () => {
  const toggleDoc = (collapsed: boolean) =>
    n.doc.create(null, [
      n.bullet_list.create(null, [item("b", { kind: "toggle", collapsed })]),
    ]);

  it("flips the shared collapsed attr both ways", () => {
    const collapsed = run(stateAt(toggleDoc(false), "b"), toggleListItemCollapsed);
    expect(collapsed.doc.firstChild!.child(0).attrs.collapsed).toBe(true);
    const expanded = run(stateAt(toggleDoc(true), "b"), toggleListItemCollapsed);
    expect(expanded.doc.firstChild!.child(0).attrs.collapsed).toBe(false);
  });

  it("declines on a plain bullet item and outside a list", () => {
    const bullet = n.doc.create(null, [n.bullet_list.create(null, [item("b")])]);
    expect(toggleListItemCollapsed(stateAt(bullet, "b"))).toBe(false);
    expect(toggleListItemCollapsed(stateAt(n.doc.create(null, [p("b")]), "b"))).toBe(false);
  });
});
