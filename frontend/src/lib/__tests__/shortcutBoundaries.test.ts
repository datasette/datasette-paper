/**
 * Layer 2 of the shortcut test contract (plans/shortcuts design §5.4): the
 * dispatch boundaries where two handlers can claim one keystroke.
 *
 *  B1  mac vs non-mac `Mod` resolution (import-time platform sniff; the mac
 *      half is shortcutMacResolution.test.ts)
 *  B2  shifted punctuation — covered by fixtures in shortcutBindings.test.ts
 *  B3  suggestion popup vs editor command (real DOM dispatch)
 *  B4  CodeMirror vs outer ProseMirror undo
 *  B5  Tab with a table nested in a list / a list nested in a table
 *  B6  real DOM propagation of a paper-owned chord
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undoDepth } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { buildKeymap } from "prosemirror-example-setup";
import type { Node as PMNode } from "prosemirror-model";

import { EditorConnection } from "../collab";
import { schema } from "../schema";
import { slashKey } from "../slashMenu";
import { CodeBlockView } from "../codeBlockView";
import { codeFocusPlugin } from "../codeFocusPlugin";
import { codeHighlightPlugin } from "../codeHighlight";
import { loadCmCore } from "../cmCore";
import {
  MockEventSource,
  makeBootstrapFetch,
  makeEl,
  makeOpts,
  waitFor,
} from "./helpers/editorHarness";

const n = schema.nodes;
const p = (text = "") => n.paragraph.create(null, text ? schema.text(text) : null);
const li = (...c: PMNode[]) => n.list_item.create(null, c);
const ti = (...c: PMNode[]) => n.task_item.create(null, c);
const cell = (text: string) => n.table_cell.create(null, p(text));
const table = (...rows: string[][]) =>
  n.table.create(
    null,
    rows.map((r) => n.table_row.create(null, r.map(cell))),
  );

async function withEditor(
  content: PMNode[],
  body: (view: EditorView) => void | Promise<void>,
): Promise<void> {
  (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();
  const conn = new EditorConnection(makeOpts(makeEl()));
  try {
    await waitFor(() => expect(conn.view).not.toBeNull());
    const view = conn.view!;
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, content));
    await body(view);
  } finally {
    conn.close();
  }
}

function textPos(view: EditorView, text: string): number {
  let pos = -1;
  view.state.doc.descendants((node, at) => {
    if (pos === -1 && node.isText && node.text === text) pos = at;
  });
  if (pos === -1) throw new Error(`no text ${text}`);
  return pos;
}

function cursorAt(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

function keydown(view: EditorView, init: KeyboardEventInit): boolean {
  const evt = new KeyboardEvent("keydown", init);
  return !!view.someProp("handleKeyDown", (fn) => fn(view, evt));
}

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ─── B1 ─────────────────────────────────────────────────────────────────────

// The mac half lives in shortcutMacResolution.test.ts: prosemirror-keymap /
// -example-setup are externalized deps, so `vi.resetModules()` + dynamic import
// does NOT re-run their import-time `navigator.platform` sniff — the stub has
// to be hoisted above every import in a file of its own.
describe("B1: Mod resolves per platform at import time (non-mac half)", () => {
  it("non-mac (jsdom default): Ctrl-z undoes, Ctrl-y redoes", () => {
    const doc = schema.node("doc", null, [p("Hello")]);
    let st = EditorState.create({
      doc,
      plugins: [history(), keymap(buildKeymap(schema))],
    });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 6)));
    const place = document.createElement("div");
    document.body.appendChild(place);
    const v = new EditorView(place, { state: st });
    v.dispatch(v.state.tr.insertText("!"));
    expect(keydown(v, { key: "z", keyCode: 90, ctrlKey: true })).toBe(true);
    expect(v.state.doc.textContent).toBe("Hello");
    expect(keydown(v, { key: "y", keyCode: 89, ctrlKey: true })).toBe(true);
    expect(v.state.doc.textContent).toBe("Hello!");
    v.destroy();
  });
});

// ─── B3 ─────────────────────────────────────────────────────────────────────

describe("B3: slash popup wins over editor commands", () => {
  function openSlash(view: EditorView): void {
    const pos = textPos(view, "item ") + 5;
    cursorAt(view, pos);
    view.dispatch(view.state.tr.insertText("/"));
    expect(slashKey.getState(view.state)?.active).toBe(true);
  }

  function countTaskItems(view: EditorView): number {
    let count = 0;
    view.state.doc.descendants((node) => {
      if (node.type === n.task_item) count++;
    });
    return count;
  }

  it("Escape cancels the popup — no selectParentNode, no page-level listener", async () => {
    await withEditor([n.task_list.create(null, [ti(p("item "))])], (view) => {
      openSlash(view);
      const windowSaw = vi.fn();
      window.addEventListener("keydown", windowSaw);
      try {
        view.dom.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      } finally {
        window.removeEventListener("keydown", windowSaw);
      }
      expect(slashKey.getState(view.state)?.active).toBe(false);
      expect(view.state.selection).not.toBeInstanceOf(NodeSelection);
      expect(windowSaw).not.toHaveBeenCalled();
    });
  });

  it("Enter commits the slash row instead of splitting the task item", async () => {
    await withEditor([n.task_list.create(null, [ti(p("item "))])], (view) => {
      openSlash(view);
      const before = countTaskItems(view);
      view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }),
      );
      expect(slashKey.getState(view.state)?.active).toBe(false);
      expect(view.state.doc.textContent).not.toContain("/");
      expect(countTaskItems(view)).toBe(before);
    });
  });
});

// ─── B4 ─────────────────────────────────────────────────────────────────────

describe("B4: Mod-z inside CodeMirror undoes exactly one PM step", () => {
  const mounted: EditorView[] = [];
  afterEach(() => {
    for (const v of mounted.splice(0)) v.destroy();
  });

  it("history depth drops by 1 and the event is defaultPrevented", async () => {
    const doc = schema.node("doc", null, [
      p("intro"),
      schema.node("code_block", { language: null }, [schema.text("abc")]),
    ]);
    const state = EditorState.create({
      doc,
      plugins: [history(), codeFocusPlugin(), codeHighlightPlugin(), keymap(baseKeymap)],
    });
    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state,
      nodeViews: {
        code_block: (node, v, getPos) =>
          new CodeBlockView(node, v, getPos as () => number | undefined),
      },
    });
    mounted.push(view);
    let codePos = -1;
    view.state.doc.descendants((node, at) => {
      if (node.type === n.code_block) codePos = at;
    });
    cursorAt(view, codePos + 1 + 3);
    const cmEl = (await vi.waitFor(() => {
      const el = view.dom.querySelector(".cm-editor");
      if (!el) throw new Error("no .cm-editor yet");
      return el;
    })) as HTMLElement;
    const core = await loadCmCore();
    const cm = core.EditorView.findFromDOM(cmEl)!;
    cm.focus();
    if (!cm.hasFocus) return; // jsdom focus unavailable (see codeBlockCm.test.ts).

    cm.dispatch({ changes: { from: 3, to: 3, insert: "d" } });
    await vi.waitFor(() => {
      if (view.state.doc.nodeAt(codePos)?.textContent !== "abcd") throw new Error("not synced");
    });
    const depth = undoDepth(view.state);
    const evt = new KeyboardEvent("keydown", {
      key: "z",
      code: "KeyZ",
      keyCode: 90,
      ctrlKey: true, // jsdom is non-mac
      bubbles: true,
      cancelable: true,
    });
    cm.contentDOM.dispatchEvent(evt);
    await vi.waitFor(() => {
      if (view.state.doc.nodeAt(codePos)?.textContent !== "abc") throw new Error("not undone");
    });
    expect(undoDepth(view.state)).toBe(depth - 1);
    expect(evt.defaultPrevented).toBe(true);
  });
});

// ─── B5 ─────────────────────────────────────────────────────────────────────

describe("B5: Tab — the innermost of table/list wins", () => {
  it("a table nested in a list item: Tab moves to the next cell", async () => {
    await withEditor(
      [n.bullet_list.create(null, [li(p("item"), table(["c00", "c01"], ["c10", "c11"]))])],
      (view) => {
        cursorAt(view, textPos(view, "c00") + 1);
        const listBefore = view.state.doc.firstChild!.toJSON();
        const handled = keydown(view, { key: "Tab", keyCode: 9 });
        expect(handled).toBe(true);
        const { $from } = view.state.selection;
        expect($from.parent.textContent).toBe("c01");
        // The list structure didn't change (no sink/lift).
        expect(view.state.doc.firstChild!.toJSON()).toEqual(listBefore);
      },
    );
  });

  it("a list nested in a table cell: Tab indents the item", async () => {
    const cellWithList = n.table_cell.create(null, [
      n.bullet_list.create(null, [li(p("a")), li(p("b"))]),
    ]);
    await withEditor(
      [n.table.create(null, [n.table_row.create(null, [cellWithList, cell("other")])])],
      (view) => {
        const bPos = textPos(view, "b");
        cursorAt(view, bPos + 1);
        const depthBefore = view.state.doc.resolve(bPos).depth;
        expect(keydown(view, { key: "Tab", keyCode: 9 })).toBe(true);
        const depthAfter = view.state.doc.resolve(textPos(view, "b")).depth;
        expect(depthAfter).toBe(depthBefore + 2);
        expect(view.state.selection.$from.parent.textContent).toBe("b");
      },
    );
  });
});

// ─── B6 ─────────────────────────────────────────────────────────────────────

describe("B6: a paper-owned chord stops at the editor", () => {
  it("Ctrl-Shift-X applies strike and never reaches window listeners", async () => {
    await withEditor([p("Hello")], (view) => {
      const from = textPos(view, "Hello");
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 5)),
      );
      const windowSaw = vi.fn();
      window.addEventListener("keydown", windowSaw);
      try {
        view.dom.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "X",
            keyCode: 88,
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      } finally {
        window.removeEventListener("keydown", windowSaw);
      }
      expect(view.state.doc.rangeHasMark(from, from + 5, schema.marks.strike)).toBe(true);
      expect(windowSaw).not.toHaveBeenCalled();
    });
  });
});
