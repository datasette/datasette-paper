/**
 * Layer 1 of the shortcut test contract (plans/shortcuts design §5.4): every
 * `SHORTCUTS` registry entry is proven to do what its hint says, through the
 * dispatcher that owns it.
 *
 *  - prose rows: a live `EditorConnection` + `view.someProp("handleKeyDown")`.
 *  - sql rows: a mounted `sql_block`, dispatching on the CM `contentDOM`.
 *
 * Key events come from HAND-WRITTEN fixtures, never from `parseShortcut`, so a
 * parser bug can't hide itself. The one place the parser meets the fixtures is
 * the mapping test, which makes an edit to an `owner: "upstream"` registry key
 * fail loudly here until the `buildKeymap` binding changes too.
 *
 * jsdom is non-mac (`navigator.platform === ""`), so `Mod` means `ctrlKey`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import type { Node as PMNode } from "prosemirror-model";

import { EditorConnection } from "../collab";
import { schema } from "../schema";
import { resetLastHighlightColor } from "../highlight";
import { SHORTCUTS, parseShortcut, type ShortcutId } from "../shortcuts";
import { SqlBlockView, clearSqlResultCache } from "../sqlBlockView";
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

// @feat shortcuts: test — every registry chord reaches the command its hint names
type Init = KeyboardEventInit & { key: string; keyCode: number };

// ─── Fixtures (hand-written; non-mac) ───────────────────────────────────────
// B2 (shifted punctuation, design §5.4) is covered by the taskList `&`,
// blockquote `>`, divider `_` and dateTomorrow `:` rows: each relies on
// prosemirror-keymap's shift / keyCode base-name fallback.

const EVENTS: Record<ShortcutId, Init> = {
  undo: { key: "z", keyCode: 90, ctrlKey: true },
  redo: { key: "Z", keyCode: 90, ctrlKey: true, shiftKey: true },
  bold: { key: "b", keyCode: 66, ctrlKey: true },
  italic: { key: "i", keyCode: 73, ctrlKey: true },
  code: { key: "`", keyCode: 192, ctrlKey: true },
  strike: { key: "X", keyCode: 88, ctrlKey: true, shiftKey: true },
  highlight: { key: "H", keyCode: 72, ctrlKey: true, shiftKey: true },
  link: { key: "k", keyCode: 75, ctrlKey: true },
  paragraph: { key: ")", keyCode: 48, ctrlKey: true, shiftKey: true },
  heading1: { key: "!", keyCode: 49, ctrlKey: true, shiftKey: true },
  heading2: { key: "@", keyCode: 50, ctrlKey: true, shiftKey: true },
  heading3: { key: "#", keyCode: 51, ctrlKey: true, shiftKey: true },
  blockquote: { key: ">", keyCode: 190, ctrlKey: true, shiftKey: true }, // B2
  codeBlock: { key: "|", keyCode: 220, ctrlKey: true, shiftKey: true },
  bulletList: { key: "*", keyCode: 56, ctrlKey: true, shiftKey: true },
  orderedList: { key: "(", keyCode: 57, ctrlKey: true, shiftKey: true },
  taskList: { key: "&", keyCode: 55, ctrlKey: true, shiftKey: true }, // B2
  indent: { key: "]", keyCode: 221, ctrlKey: true },
  outdent: { key: "[", keyCode: 219, ctrlKey: true },
  dateToday: { key: ";", keyCode: 186, ctrlKey: true },
  dateTomorrow: { key: ":", keyCode: 186, ctrlKey: true, shiftKey: true }, // B2
  divider: { key: "_", keyCode: 189, ctrlKey: true, shiftKey: true }, // B2
  runQuery: { key: "Enter", keyCode: 13, ctrlKey: true },
};

/** US-layout unshifted key for a keyCode — just the codes the fixtures use. */
const BASE_KEY: Record<number, string> = {
  13: "Enter",
  48: "0",
  49: "1",
  50: "2",
  51: "3",
  55: "7",
  56: "8",
  57: "9",
  186: ";",
  189: "-",
  190: ".",
  192: "`",
  219: "[",
  220: "\\",
  221: "]",
};

// ─── Prose harness ──────────────────────────────────────────────────────────

type P = PMNode;
const n = schema.nodes;
const p = (text = "") => n.paragraph.create(null, text ? schema.text(text) : null);
const li = (...c: P[]) => n.list_item.create(null, c);
const ti = (...c: P[]) => n.task_item.create(null, c);

async function withEditor(
  content: P[],
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

/** Put the cursor inside the first text node equal to `text` (+offset). */
function cursorIn(view: EditorView, text: string, offset = 0): void {
  let pos = -1;
  view.state.doc.descendants((node, at) => {
    if (pos === -1 && node.isText && node.text === text) pos = at + offset;
  });
  if (pos === -1) throw new Error(`no text ${text}`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

function selectAllText(view: EditorView, text: string): [number, number] {
  let from = -1;
  view.state.doc.descendants((node, at) => {
    if (from === -1 && node.isText && node.text === text) from = at;
  });
  const to = from + text.length;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  return [from, to];
}

function press(view: EditorView, id: ShortcutId): boolean {
  const evt = new KeyboardEvent("keydown", EVENTS[id]);
  return !!view.someProp("handleKeyDown", (fn) => fn(view, evt));
}

function ancestorTypes(view: EditorView): string[] {
  const { $from } = view.state.selection;
  const out: string[] = [];
  for (let d = $from.depth; d > 0; d--) out.push($from.node(d).type.name);
  return out;
}

function depthOfText(view: EditorView, text: string): number {
  let depth = -1;
  view.state.doc.descendants((node, at) => {
    if (depth === -1 && node.isText && node.text === text) {
      depth = view.state.doc.resolve(at).depth;
    }
  });
  return depth;
}

function hasNode(view: EditorView, type: string): boolean {
  let found = false;
  view.state.doc.descendants((node) => {
    if (node.type.name === type) found = true;
  });
  return found;
}

const PROSE_ROWS: Record<string, (id: ShortcutId) => Promise<void>> = {};

function markRow(id: ShortcutId, mark: keyof typeof schema.marks) {
  PROSE_ROWS[id] = () =>
    withEditor([p("Hello")], (view) => {
      const [from, to] = selectAllText(view, "Hello");
      expect(press(view, id)).toBe(true);
      expect(view.state.doc.rangeHasMark(from, to, schema.marks[mark])).toBe(true);
    });
}

function wrapRow(id: ShortcutId, ancestor: string) {
  PROSE_ROWS[id] = () =>
    withEditor([p("Hello")], (view) => {
      cursorIn(view, "Hello", 1);
      expect(press(view, id)).toBe(true);
      expect(ancestorTypes(view)).toContain(ancestor);
    });
}

PROSE_ROWS.undo = () =>
  withEditor([p("Hello")], (view) => {
    cursorIn(view, "Hello", 5);
    view.dispatch(view.state.tr.insertText("!"));
    expect(view.state.doc.textContent).toBe("Hello!");
    expect(press(view, "undo")).toBe(true);
    expect(view.state.doc.textContent).toBe("Hello");
  });

PROSE_ROWS.redo = () =>
  withEditor([p("Hello")], (view) => {
    cursorIn(view, "Hello", 5);
    view.dispatch(view.state.tr.insertText("!"));
    expect(press(view, "undo")).toBe(true);
    expect(view.state.doc.textContent).toBe("Hello");
    expect(press(view, "redo")).toBe(true);
    expect(view.state.doc.textContent).toBe("Hello!");
  });

markRow("bold", "strong");
markRow("italic", "em");
markRow("code", "code");
markRow("strike", "strike");
markRow("highlight", "highlight");

PROSE_ROWS.link = () =>
  withEditor([p("Hello")], (view) => {
    // toggleLinkCommand prompts for the URL; jsdom's prompt returns null.
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("https://example.com");
    const [from, to] = selectAllText(view, "Hello");
    expect(press(view, "link")).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(view.state.doc.rangeHasMark(from, to, schema.marks.link)).toBe(true);
  });

PROSE_ROWS.paragraph = () =>
  withEditor([n.heading.create({ level: 1 }, schema.text("Hello"))], (view) => {
    cursorIn(view, "Hello", 1);
    expect(press(view, "paragraph")).toBe(true);
    expect(view.state.doc.firstChild!.type.name).toBe("paragraph");
  });

for (const level of [1, 2, 3] as const) {
  const id = `heading${level}` as const;
  PROSE_ROWS[id] = () =>
    withEditor([p("Hello")], (view) => {
      cursorIn(view, "Hello", 1);
      expect(press(view, id)).toBe(true);
      const top = view.state.doc.firstChild!;
      expect(top.type.name).toBe("heading");
      expect(top.attrs.level).toBe(level);
    });
}

wrapRow("blockquote", "blockquote");

PROSE_ROWS.codeBlock = () =>
  withEditor([p("Hello")], (view) => {
    cursorIn(view, "Hello", 1);
    expect(press(view, "codeBlock")).toBe(true);
    expect(view.state.doc.firstChild!.type.name).toBe("code_block");
  });

wrapRow("bulletList", "bullet_list");
wrapRow("orderedList", "ordered_list");
// current model (task_item); list-kinds 03 updates
wrapRow("taskList", "task_list");

// Indent / outdent (paper-owned, task-aware — D1) run in a bullet list AND a
// task list. The task-list fixtures are current model (task_item);
// list-kinds 05 updates.
const flatList = (kind: "bullet" | "task") =>
  kind === "bullet"
    ? n.bullet_list.create(null, [li(p("a")), li(p("b"))])
    : n.task_list.create(null, [ti(p("a")), ti(p("b"))]);
const nestedList = (kind: "bullet" | "task") =>
  kind === "bullet"
    ? n.bullet_list.create(null, [li(p("a"), n.bullet_list.create(null, [li(p("b"))]))])
    : n.task_list.create(null, [ti(p("a"), n.task_list.create(null, [ti(p("b"))]))]);

PROSE_ROWS.indent = async () => {
  for (const kind of ["bullet", "task"] as const) {
    await withEditor([flatList(kind)], (view) => {
      cursorIn(view, "b", 1);
      const before = depthOfText(view, "b");
      expect(press(view, "indent"), kind).toBe(true);
      expect(depthOfText(view, "b"), kind).toBe(before + 2);
    });
  }
};

PROSE_ROWS.outdent = async () => {
  for (const kind of ["bullet", "task"] as const) {
    await withEditor([nestedList(kind)], (view) => {
      cursorIn(view, "b", 1);
      const before = depthOfText(view, "b");
      expect(press(view, "outdent"), kind).toBe(true);
      expect(depthOfText(view, "b"), kind).toBe(before - 2);
    });
  }
};

for (const id of ["dateToday", "dateTomorrow"] as const) {
  PROSE_ROWS[id] = () =>
    withEditor([p("Hello")], (view) => {
      cursorIn(view, "Hello", 5);
      expect(press(view, id)).toBe(true);
      expect(hasNode(view, "date")).toBe(true);
    });
}

PROSE_ROWS.divider = () =>
  withEditor([p("Hello")], (view) => {
    cursorIn(view, "Hello", 5);
    expect(press(view, "divider")).toBe(true);
    expect(hasNode(view, "horizontal_rule")).toBe(true);
  });

// ─── SQL harness ────────────────────────────────────────────────────────────

let queryFetches = 0;
const mounted: EditorView[] = [];

function mountSql(sql: string): EditorView {
  const doc = schema.node("doc", null, [
    p("intro"),
    schema.node("sql_block", { db: "data", hidden: false }, [schema.text(sql)]),
  ]);
  const state = EditorState.create({
    doc,
    plugins: [history(), codeFocusPlugin(), codeHighlightPlugin(), keymap(baseKeymap)],
  });
  const place = document.createElement("div");
  place.className = "editor-host";
  document.body.appendChild(place);
  const view = new EditorView(place, {
    state,
    nodeViews: {
      sql_block: (node, v, getPos) => new SqlBlockView(node, v, getPos as () => number | undefined),
    },
  });
  mounted.push(view);
  return view;
}

const SQL_ROWS: Record<string, (id: ShortcutId) => Promise<void>> = {
  runQuery: async (id) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/.json")) {
          return { ok: true, status: 200, json: async () => ({ databases: [{ name: "data" }] }) };
        }
        queryFetches++;
        return { ok: true, status: 200, json: async () => ({ ok: true, columns: ["n"], rows: [[1]] }) };
      }),
    );
    const view = mountSql("select 1");
    await vi.waitFor(() => {
      if (!view.dom.querySelector("table")) throw new Error("no results yet");
    });
    let blockStart = -1;
    view.state.doc.descendants((node, at) => {
      if (node.type.name === "sql_block") blockStart = at + 1;
    });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, blockStart + 3)),
    );
    const cmEl = (await vi.waitFor(() => {
      const el = view.dom.querySelector(".cm-editor");
      if (!el) throw new Error("no .cm-editor yet");
      return el;
    })) as HTMLElement;
    const core = await loadCmCore();
    const cm = core.EditorView.findFromDOM(cmEl)!;
    const before = queryFetches;
    cm.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { ...EVENTS[id], code: "Enter", bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => {
      if (queryFetches !== before + 1) throw new Error("Mod-Enter did not refetch");
    });
  },
};

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as Record<string, unknown>).EventSource = MockEventSource;
  resetLastHighlightColor();
  clearSqlResultCache();
  queryFetches = 0;
});

afterEach(() => {
  for (const v of mounted.splice(0)) v.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// ─── Tests ──────────────────────────────────────────────────────────────────

const ids = Object.keys(SHORTCUTS) as ShortcutId[];
const idsFor = (s: "prose" | "sql") => ids.filter((id) => SHORTCUTS[id].surface === s);

describe("registry ↔ binding rows cover every entry", () => {
  it("prose rows equal the registry's prose ids", () => {
    expect(Object.keys(PROSE_ROWS).sort()).toEqual(idsFor("prose").sort());
  });
  it("sql rows equal the registry's sql ids", () => {
    expect(Object.keys(SQL_ROWS).sort()).toEqual(idsFor("sql").sort());
  });
  it("every registry entry has a fixture", () => {
    expect(Object.keys(EVENTS).sort()).toEqual([...ids].sort());
  });
});

describe("registry key agrees with the hand-written fixture", () => {
  for (const id of ids) {
    it(id, () => {
      const parsed = parseShortcut(SHORTCUTS[id].key);
      const ev = EVENTS[id];
      // jsdom is non-mac: Mod → Ctrl.
      expect(parsed.ctrl || parsed.mod).toBe(!!ev.ctrlKey);
      expect(parsed.meta).toBe(!!ev.metaKey);
      expect(parsed.alt).toBe(!!ev.altKey);
      const base = BASE_KEY[ev.keyCode] ?? ev.key.toLowerCase();
      const sameShiftAndBase =
        parsed.shift === !!ev.shiftKey && parsed.key.toLowerCase() === base.toLowerCase();
      // A chord naming a shifted character (`Ctrl->`, `Mod-_`) is typed with
      // Shift held and reported as that character.
      const shiftedChar = !parsed.shift && !!ev.shiftKey && parsed.key === ev.key;
      expect(sameShiftAndBase || shiftedChar).toBe(true);
    });
  }
});

describe("prose shortcuts do what their hint says", () => {
  for (const id of idsFor("prose")) {
    it(`${id} (${SHORTCUTS[id].key})`, async () => {
      await PROSE_ROWS[id](id);
    });
  }
});

describe("sql shortcuts do what their hint says", () => {
  for (const id of idsFor("sql")) {
    it(`${id} (${SHORTCUTS[id].key})`, async () => {
      await SQL_ROWS[id](id);
    });
  }
});

describe("indent / outdent chords outside the handled context", () => {
  it("Mod-] / Mod-[ in a plain paragraph are not handled (fall through)", async () => {
    await withEditor([p("Hello")], (view) => {
      cursorIn(view, "Hello", 1);
      expect(press(view, "indent")).toBe(false);
      expect(press(view, "outdent")).toBe(false);
    });
  });

  it("a real Ctrl-] keydown on view.dom indents a task item", async () => {
    // current model (task_item); list-kinds 05 updates
    await withEditor([flatList("task")], (view) => {
      cursorIn(view, "b", 1);
      const before = depthOfText(view, "b");
      const evt = new KeyboardEvent("keydown", {
        ...EVENTS.indent,
        bubbles: true,
        cancelable: true,
      });
      view.dom.dispatchEvent(evt);
      expect(evt.defaultPrevented).toBe(true);
      expect(depthOfText(view, "b")).toBe(before + 2);
    });
  });
});
