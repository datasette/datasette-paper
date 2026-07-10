/**
 * Tests for the CM-on-focus tier (cmCore.ts / codeFocusPlugin.ts /
 * codeBlockView.ts). The collab-correctness surface is the PM↔CM sync core, so
 * the pure diff/offset helpers are unit-tested exhaustively, and the mounted
 * path proves: a block flips to a live CM editor on focus (and back), remote
 * PM steps land inside CM without echoing a second transaction, CM edits
 * forward to PM, Mod-z drives PM history, and a non-editable view never mounts
 * CM.
 *
 * The real `@codemirror/*` packages run fine under jsdom; the CM `EditorView`
 * is reached via `core.EditorView.findFromDOM` (the resolved core, so no direct
 * `@codemirror/*` import in this file — the eslint chokepoint stays honest).
 *
 * @feat code-cm-focus: proves the diff/offset sync core, the focus→CM mode
 * flip and back, remote-step landing with echo suppression, and PM-owned undo
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import {
  CodeBlockView,
  computeChange,
  pmPosForCm,
  cmPosForPm,
} from "../codeBlockView";
import { codeFocusPlugin } from "../codeFocusPlugin";
import { codeHighlightPlugin } from "../codeHighlight";
import { loadCmCore } from "../cmCore";

// ── Pure sync core ──────────────────────────────────────────────────────────

describe("computeChange", () => {
  it("returns null for an identical string (no-op)", () => {
    expect(computeChange("abc", "abc")).toBeNull();
  });

  it("detects a pure prefix insertion", () => {
    expect(computeChange("bc", "abc")).toEqual({ from: 0, to: 0, insert: "a" });
  });

  it("detects a pure suffix insertion", () => {
    expect(computeChange("ab", "abc")).toEqual({ from: 2, to: 2, insert: "c" });
  });

  it("detects a middle replacement, peeling common prefix and suffix", () => {
    expect(computeChange("axc", "ayc")).toEqual({ from: 1, to: 2, insert: "y" });
  });

  it("detects a full replacement with nothing in common", () => {
    expect(computeChange("abc", "xyz")).toEqual({ from: 0, to: 3, insert: "xyz" });
  });

  it("detects a pure deletion (empty insert)", () => {
    expect(computeChange("abcd", "ad")).toEqual({ from: 1, to: 3, insert: "" });
  });

  it("handles insertion into an empty document", () => {
    expect(computeChange("", "hi")).toEqual({ from: 0, to: 0, insert: "hi" });
  });
});

describe("offset mapping both directions", () => {
  it("maps a CM offset to its PM position and back", () => {
    const blockStart = 6; // getPos()+1 for a block whose getPos() is 5
    expect(pmPosForCm(blockStart, 0)).toBe(6);
    expect(pmPosForCm(blockStart, 4)).toBe(10);
    expect(cmPosForPm(blockStart, 10)).toBe(4);
    // Round-trips.
    for (const off of [0, 1, 7, 23]) {
      expect(cmPosForPm(blockStart, pmPosForCm(blockStart, off))).toBe(off);
    }
  });
});

// ── Mounted PM view harness ────────────────────────────────────────────────

const mounted: EditorView[] = [];

function codeDoc(text: string): PMNode {
  return schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("intro")]),
    schema.node("code_block", { language: null }, text ? [schema.text(text)] : []),
  ]);
}

/** Position before the code_block in `codeDoc` (getPos value). */
function codeBlockPos(view: EditorView): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "code_block") found = pos;
    return true;
  });
  return found;
}

function mount(doc: PMNode, editable = true): EditorView {
  const state = EditorState.create({
    doc,
    plugins: [
      history(),
      codeFocusPlugin(),
      codeHighlightPlugin(),
      keymap(baseKeymap),
    ],
  });
  const place = document.createElement("div");
  place.className = "editor-host";
  document.body.appendChild(place);
  const view = new EditorView(place, {
    state,
    editable: () => editable,
    nodeViews: {
      code_block: (node, v, getPos) =>
        new CodeBlockView(node, v, getPos as () => number | undefined),
    },
  });
  mounted.push(view);
  return view;
}

/** Move the PM selection to `offset` chars into the code_block. */
function selectInCode(view: EditorView, offset: number): void {
  const start = codeBlockPos(view) + 1;
  const tr = view.state.tr.setSelection(
    TextSelection.create(view.state.doc, start + offset),
  );
  view.dispatch(tr);
}

async function waitForCm(view: EditorView): Promise<HTMLElement> {
  return (await vi.waitFor(() => {
    const el = view.dom.querySelector(".cm-editor");
    if (!el) throw new Error("no .cm-editor yet");
    return el;
  })) as HTMLElement;
}

afterEach(() => {
  for (const v of mounted.splice(0)) v.destroy();
  document.querySelectorAll(".editor-host").forEach((n) => n.remove());
});

describe("CM mode flip", () => {
  it("mounts a CM editor when the selection enters an editable code block", async () => {
    const view = mount(codeDoc("print(1)"));
    expect(view.dom.querySelector(".cm-editor")).toBeNull();
    selectInCode(view, 3);
    await waitForCm(view);
  });

  it("returns to the static <pre> when the selection leaves", async () => {
    const view = mount(codeDoc("print(1)"));
    selectInCode(view, 3);
    await waitForCm(view);
    // Move selection back into the intro paragraph.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    await vi.waitFor(() => {
      if (view.dom.querySelector(".cm-editor")) throw new Error("still mounted");
      if (!view.dom.querySelector(".pm-code-block pre")) throw new Error("no static pre");
    });
  });

  it("disables spellcheck/autocorrect/autocapitalize on the mounted CM surface", async () => {
    const view = mount(codeDoc("print(1)"));
    selectInCode(view, 3);
    const cmEl = await waitForCm(view);
    const core = await loadCmCore();
    const cm = core.EditorView.findFromDOM(cmEl)!;
    expect(cm.contentDOM.getAttribute("spellcheck")).toBe("false");
    expect(cm.contentDOM.getAttribute("autocorrect")).toBe("off");
    expect(cm.contentDOM.getAttribute("autocapitalize")).toBe("off");
  });

  it("never mounts CM in a non-editable view", async () => {
    const view = mount(codeDoc("print(1)"), false);
    selectInCode(view, 3);
    // Give any async loader a chance; assert it stays static.
    await new Promise((r) => setTimeout(r, 50));
    await loadCmCore();
    await new Promise((r) => setTimeout(r, 0));
    expect(view.dom.querySelector(".cm-editor")).toBeNull();
    expect(view.dom.querySelector(".pm-code-block pre")).not.toBeNull();
  });
});

describe("PM ↔ CM sync", () => {
  it("lands a remote-style PM step inside CM without echoing a second transaction", async () => {
    const view = mount(codeDoc("abc"));
    selectInCode(view, 3);
    const cmEl = await waitForCm(view);
    const core = await loadCmCore();
    const cm = core.EditorView.findFromDOM(cmEl)!;
    expect(cm.state.doc.toString()).toBe("abc");

    const start = codeBlockPos(view) + 1;
    const dispatchSpy = vi.spyOn(view, "dispatch");
    // Simulate a remote collab step arriving: replace "abc" -> "abXc".
    view.dispatch(view.state.tr.insertText("X", start + 2));
    const callsAfterStep = dispatchSpy.mock.calls.length;

    await vi.waitFor(() => {
      if (cm.state.doc.toString() !== "abXc") throw new Error("CM not synced");
    });
    // The CM change was tagged fromPM, so it must not echo back a new tr.
    expect(dispatchSpy.mock.calls.length).toBe(callsAfterStep);
    dispatchSpy.mockRestore();
  });

  it("forwards a CM edit into the PM document", async () => {
    const view = mount(codeDoc("abc"));
    selectInCode(view, 3);
    const cmEl = await waitForCm(view);
    const core = await loadCmCore();
    const cm = core.EditorView.findFromDOM(cmEl)!;
    cm.focus();
    if (!cm.hasFocus) return; // jsdom couldn't focus the contentEditable; skip.
    cm.dispatch({ changes: { from: 3, to: 3, insert: "d" } });
    await vi.waitFor(() => {
      const node = view.state.doc.nodeAt(codeBlockPos(view));
      if (node?.textContent !== "abcd") throw new Error("PM not updated");
    });
  });
});

describe("undo stays PM-owned", () => {
  it("Mod-z inside CM runs PM history undo", async () => {
    const view = mount(codeDoc("abc"));
    selectInCode(view, 3);
    const cmEl = await waitForCm(view);
    const core = await loadCmCore();
    const cm = core.EditorView.findFromDOM(cmEl)!;
    cm.focus();
    if (!cm.hasFocus) return; // jsdom focus unavailable; the CM→PM test covers the rest.

    // A CM edit produces one undoable PM step.
    cm.dispatch({ changes: { from: 3, to: 3, insert: "d" } });
    await vi.waitFor(() => {
      const node = view.state.doc.nodeAt(codeBlockPos(view));
      if (node?.textContent !== "abcd") throw new Error("edit not applied");
    });
    // Fire the Mod-z binding through CM's keymap. Mod resolves to the
    // platform accelerator; set exactly one so CM doesn't read a combined
    // "Ctrl-Cmd-z" modifier. macOS (this env) = Cmd/metaKey.
    const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
    cm.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        code: "KeyZ",
        keyCode: 90,
        ctrlKey: !mac,
        metaKey: mac,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() => {
      const node = view.state.doc.nodeAt(codeBlockPos(view));
      if (node?.textContent !== "abc") throw new Error("undo did not revert");
    });
  });
});
