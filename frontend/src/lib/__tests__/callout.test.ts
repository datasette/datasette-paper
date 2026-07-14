// @feat callout: unit tests — insert/wrap/upgrade/to-quote/unwrap commands,
// the `[!kind] ` input rule (incl. the `> [!warning] ` two-rule chain), and the
// title Enter + empty-title Backspace keymap handlers.
/**
 * Command + input-rule + keymap tests for the callout block. Commands run
 * against fabricated `EditorState`s via a tiny `apply` helper (dispatch → new
 * state), so happy paths and refusals are asserted purely on `doc`/`selection`.
 * The input rule is driven through a minimal `EditorView` (only the paper
 * structural input rules installed) with the 5-arg
 * `someProp("handleTextInput", …)` form, matching frontend/CLAUDE.md.
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState, TextSelection, Selection, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { inputRules } from "prosemirror-inputrules";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import {
  insertCallout,
  wrapSelectionInCallout,
  upgradeBlockquote,
  calloutToQuote,
  unwrapCallout,
  enterInCalloutTitle,
  backspaceEmptyCalloutTitle,
} from "../callout";
import { buildPaperStructuralRules } from "../collab";

const { doc, paragraph, blockquote, callout, callout_title, bullet_list, list_item } = schema.nodes;

/** Run a command against a state; returns the resulting state (or the original
 * when the command refused) plus whether it reported handled. */
function apply(state: EditorState, command: Command): { state: EditorState; ok: boolean } {
  let next = state;
  const ok = command(state, (tr) => {
    next = state.apply(tr);
  });
  return { state: next, ok };
}

function stateWith(node: PMNode, selAt?: number): EditorState {
  const d = doc.create(null, node.type === doc ? node.content : [node]);
  const selection = selAt != null ? TextSelection.create(d, selAt) : Selection.atStart(d);
  return EditorState.create({ doc: d, selection });
}

describe("insertCallout", () => {
  it("replaces an empty top-level paragraph with callout(title, paragraph), cursor in the title", () => {
    const state = stateWith(paragraph.create(), 1);
    const { state: next, ok } = apply(state, insertCallout("tip"));
    expect(ok).toBe(true);
    const top = next.doc.firstChild!;
    expect(top.type.name).toBe("callout");
    expect(top.attrs.kind).toBe("tip");
    expect(top.child(0).type.name).toBe("callout_title");
    expect(top.child(1).type.name).toBe("paragraph");
    // Cursor sits inside the (empty) title.
    expect(next.selection.$from.parent.type.name).toBe("callout_title");
  });

  it("refuses a non-empty paragraph", () => {
    const state = stateWith(paragraph.create(null, schema.text("hi")), 2);
    expect(apply(state, insertCallout("note")).ok).toBe(false);
  });

  it("refuses when the cursor isn't at the top level", () => {
    const list = bullet_list.create(null, list_item.create(null, paragraph.create()));
    const state = stateWith(list, 3);
    expect(apply(state, insertCallout("note")).ok).toBe(false);
  });
});

describe("wrapSelectionInCallout", () => {
  it("wraps the selected top-level blocks as the callout body with an empty title", () => {
    const d = doc.create(null, [
      paragraph.create(null, schema.text("aaa")),
      paragraph.create(null, schema.text("bbb")),
    ]);
    const state = EditorState.create({
      doc: d,
      selection: TextSelection.create(d, 2, 7),
    });
    const { state: next, ok } = apply(state, wrapSelectionInCallout("warning"));
    expect(ok).toBe(true);
    const top = next.doc.firstChild!;
    expect(top.type.name).toBe("callout");
    expect(top.attrs.kind).toBe("warning");
    expect(top.childCount).toBe(3); // title + 2 paragraphs
    expect(top.child(1).textContent).toBe("aaa");
    expect(top.child(2).textContent).toBe("bbb");
    expect(next.selection.$from.parent.type.name).toBe("callout_title");
  });

  it("refuses a non-top-level selection (inside a list item)", () => {
    const list = bullet_list.create(
      null,
      list_item.create(null, paragraph.create(null, schema.text("x"))),
    );
    const state = stateWith(list, 4);
    expect(apply(state, wrapSelectionInCallout("note")).ok).toBe(false);
  });
});

describe("upgradeBlockquote", () => {
  it("replaces a top-level blockquote with a callout carrying its children", () => {
    const bq = blockquote.create(null, [
      paragraph.create(null, schema.text("one")),
      paragraph.create(null, schema.text("two")),
    ]);
    const state = stateWith(bq, 2);
    const { state: next, ok } = apply(state, upgradeBlockquote("caution"));
    expect(ok).toBe(true);
    const top = next.doc.firstChild!;
    expect(top.type.name).toBe("callout");
    expect(top.attrs.kind).toBe("caution");
    expect(top.child(0).type.name).toBe("callout_title");
    expect(top.child(0).content.size).toBe(0); // empty title
    expect(top.child(1).textContent).toBe("one");
    expect(top.child(2).textContent).toBe("two");
  });

  it("refuses a plain top-level paragraph", () => {
    const state = stateWith(paragraph.create(null, schema.text("hi")), 2);
    expect(apply(state, upgradeBlockquote("note")).ok).toBe(false);
  });
});

describe("calloutToQuote", () => {
  it("demotes an empty-title callout to a plain blockquote", () => {
    const c = callout.create({ kind: "note" }, [
      callout_title.create(),
      paragraph.create(null, schema.text("body")),
    ]);
    const state = stateWith(c, Selection.atEnd(doc.create(null, [c])).from);
    const { state: next, ok } = apply(state, calloutToQuote);
    expect(ok).toBe(true);
    const top = next.doc.firstChild!;
    expect(top.type.name).toBe("blockquote");
    expect(top.childCount).toBe(1);
    expect(top.child(0).textContent).toBe("body");
  });

  it("preserves a non-empty title as the blockquote's first paragraph", () => {
    const c = callout.create({ kind: "tip" }, [
      callout_title.create(null, schema.text("My title")),
      paragraph.create(null, schema.text("body")),
    ]);
    const state = stateWith(c, Selection.atEnd(doc.create(null, [c])).from);
    const { state: next } = apply(state, calloutToQuote);
    const top = next.doc.firstChild!;
    expect(top.type.name).toBe("blockquote");
    expect(top.child(0).type.name).toBe("paragraph");
    expect(top.child(0).textContent).toBe("My title");
    expect(top.child(1).textContent).toBe("body");
  });
});

describe("unwrapCallout", () => {
  it("lifts the body blocks to the top level, dropping an empty title", () => {
    const c = callout.create({ kind: "note" }, [
      callout_title.create(),
      paragraph.create(null, schema.text("a")),
      paragraph.create(null, schema.text("b")),
    ]);
    const state = stateWith(c, Selection.atEnd(doc.create(null, [c])).from);
    const { state: next, ok } = apply(state, unwrapCallout);
    expect(ok).toBe(true);
    expect(next.doc.childCount).toBe(2);
    expect(next.doc.child(0).textContent).toBe("a");
    expect(next.doc.child(1).textContent).toBe("b");
    expect(next.doc.child(0).type.name).toBe("paragraph");
  });

  it("keeps a non-empty title as a leading paragraph", () => {
    const c = callout.create({ kind: "note" }, [
      callout_title.create(null, schema.text("Heads up")),
      paragraph.create(null, schema.text("body")),
    ]);
    const state = stateWith(c, Selection.atEnd(doc.create(null, [c])).from);
    const { state: next } = apply(state, unwrapCallout);
    expect(next.doc.childCount).toBe(2);
    expect(next.doc.child(0).textContent).toBe("Heads up");
    expect(next.doc.child(1).textContent).toBe("body");
  });

  it("refuses outside a callout", () => {
    const state = stateWith(paragraph.create(null, schema.text("hi")), 2);
    expect(apply(state, unwrapCallout).ok).toBe(false);
  });
});

describe("keymap: Enter in callout_title", () => {
  it("moves the cursor to the first body block without splitting", () => {
    const c = callout.create({ kind: "note" }, [
      callout_title.create(),
      paragraph.create(null, schema.text("body")),
    ]);
    const state = stateWith(c, 2); // inside the empty title
    const { state: next, ok } = apply(state, enterInCalloutTitle);
    expect(ok).toBe(true);
    // Doc shape is unchanged (no split), cursor now in the body paragraph.
    expect(next.doc.firstChild!.childCount).toBe(2);
    expect(next.selection.$from.parent.type.name).toBe("paragraph");
    expect(next.selection.$from.parent.textContent).toBe("body");
  });

  it("refuses outside a title", () => {
    const state = stateWith(paragraph.create(null, schema.text("hi")), 2);
    expect(apply(state, enterInCalloutTitle).ok).toBe(false);
  });
});

describe("keymap: Backspace at start of an empty callout_title", () => {
  it("unwraps the callout", () => {
    const c = callout.create({ kind: "note" }, [
      callout_title.create(),
      paragraph.create(null, schema.text("body")),
    ]);
    const state = stateWith(c, 2); // start of empty title
    const { state: next, ok } = apply(state, backspaceEmptyCalloutTitle);
    expect(ok).toBe(true);
    expect(next.doc.firstChild!.type.name).toBe("paragraph");
    expect(next.doc.firstChild!.textContent).toBe("body");
  });

  it("refuses when the title is non-empty", () => {
    const c = callout.create({ kind: "note" }, [
      callout_title.create(null, schema.text("t")),
      paragraph.create(null, schema.text("body")),
    ]);
    const state = stateWith(c, 2); // start of non-empty title
    expect(apply(state, backspaceEmptyCalloutTitle).ok).toBe(false);
  });
});

// ─── Input rule (driven through a minimal EditorView) ───────────────────────

const mounted: EditorView[] = [];

function mountRulesView(d: PMNode, selAt: number): EditorView {
  const place = document.createElement("div");
  document.body.appendChild(place);
  const view = new EditorView(place, {
    state: EditorState.create({
      doc: d,
      selection: TextSelection.create(d, selAt),
      plugins: [inputRules({ rules: buildPaperStructuralRules() })],
    }),
  });
  mounted.push(view);
  return view;
}

/** Feed a trailing character through the input-rule pipeline (5-arg form). */
function typeChar(view: EditorView, ch: string): boolean {
  const pos = view.state.selection.from;
  return !!view.someProp("handleTextInput", (fn) => fn(view, pos, pos, ch, () => view.state.tr));
}

describe("[!kind] input rule", () => {
  afterEach(() => {
    for (const v of mounted.splice(0)) v.destroy();
  });

  it("upgrades a top-level blockquote's first paragraph to a callout", () => {
    const bq = blockquote.create(null, paragraph.create(null, schema.text("[!note]")));
    const view = mountRulesView(doc.create(null, [bq]), 9); // after "]"
    expect(typeChar(view, " ")).toBe(true);
    const top = view.state.doc.firstChild!;
    expect(top.type.name).toBe("callout");
    expect(top.attrs.kind).toBe("note");
  });

  it("is case-insensitive and clamps to the matched kind", () => {
    const bq = blockquote.create(null, paragraph.create(null, schema.text("[!WARNING]")));
    const view = mountRulesView(doc.create(null, [bq]), 12);
    expect(typeChar(view, " ")).toBe(true);
    expect(view.state.doc.firstChild!.attrs.kind).toBe("warning");
  });

  it("does NOT fire outside a blockquote", () => {
    const p = paragraph.create(null, schema.text("[!note]"));
    const view = mountRulesView(doc.create(null, [p]), 8);
    typeChar(view, " ");
    expect(view.state.doc.firstChild!.type.name).toBe("paragraph");
  });

  it("does NOT fire on a non-first paragraph of a blockquote", () => {
    const bq = blockquote.create(null, [
      paragraph.create(null, schema.text("intro")),
      paragraph.create(null, schema.text("[!note]")),
    ]);
    // cursor after "]" in the second paragraph
    const d = doc.create(null, [bq]);
    const view = mountRulesView(d, Selection.atEnd(d).from);
    typeChar(view, " ");
    expect(view.state.doc.firstChild!.type.name).toBe("blockquote");
  });

  it("drives the full `> [!warning] ` two-rule chain from a plain paragraph", () => {
    const view = mountRulesView(doc.create(null, [paragraph.create(null, schema.text(">"))]), 2);
    // 1. `> ` fires the blockquote wrapping rule.
    expect(typeChar(view, " ")).toBe(true);
    expect(view.state.doc.firstChild!.type.name).toBe("blockquote");
    // 2. type the marker text, then the trailing space fires the callout rule.
    view.dispatch(view.state.tr.insertText("[!warning]"));
    expect(typeChar(view, " ")).toBe(true);
    const top = view.state.doc.firstChild!;
    expect(top.type.name).toBe("callout");
    expect(top.attrs.kind).toBe("warning");
    expect(top.child(0).type.name).toBe("callout_title");
  });
});
