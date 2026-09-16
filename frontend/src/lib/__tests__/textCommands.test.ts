/**
 * The commands both formatting surfaces share (`textCommands.ts`): the block
 * predicates, the heading toggle, and the two link entry points. Pure over
 * `(state, dispatch)`, so these drive them with a hand-rolled dispatch and need
 * no `EditorView`. `window.prompt` is stubbed — jsdom doesn't implement it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState, Selection, TextSelection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import {
  markActive,
  nodeActive,
  setHeading,
  startWikiLink,
  toggleLink,
} from "../textCommands";

const { doc, paragraph, heading, blockquote } = schema.nodes;
const { strong, link } = schema.marks;

/** A state over `blocks`, with the selection at `from`..`to` (or at the start). */
function stateWith(blocks: PMNode[], from?: number, to?: number): EditorState {
  const d = doc.create(null, blocks);
  return EditorState.create({
    doc: d,
    selection:
      from === undefined
        ? Selection.atStart(d)
        : TextSelection.create(d, from, to ?? from),
  });
}

/** Run `cmd` and return the resulting state plus its return value. */
function run(state: EditorState, cmd: Command): { state: EditorState; ok: boolean } {
  let next = state;
  const ok = cmd(state, (tr) => {
    next = state.apply(tr);
  });
  return { state: next, ok };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("markActive / nodeActive", () => {
  it("reads a mark across a selected range", () => {
    const text = schema.text("bold text", [strong.create()]);
    const state = stateWith([paragraph.create(null, text)], 1, 5);
    expect(markActive(state, strong)).toBe(true);
    expect(markActive(state, link)).toBe(false);
  });

  it("falls back to the stored marks on an empty selection", () => {
    const base = stateWith([paragraph.create(null, schema.text("plain"))], 3);
    expect(markActive(base, strong)).toBe(false);
    const stored = base.apply(base.tr.addStoredMark(strong.create()));
    expect(markActive(stored, strong)).toBe(true);
  });

  it("matches the innermost node and its attrs", () => {
    const state = stateWith([heading.create({ level: 2 }, schema.text("Title"))], 2);
    expect(nodeActive(state, heading, { level: 2 })).toBe(true);
    expect(nodeActive(state, heading, { level: 3 })).toBe(false);
    expect(nodeActive(state, paragraph)).toBe(false);
  });
});

describe("setHeading", () => {
  it("turns a paragraph into the requested heading", () => {
    const before = stateWith([paragraph.create(null, schema.text("Hello"))], 2);
    const { state, ok } = run(before, setHeading(2));
    expect(ok).toBe(true);
    expect(state.doc.firstChild!.type).toBe(heading);
    expect(state.doc.firstChild!.attrs.level).toBe(2);
  });

  it("toggles back to a paragraph when already that level", () => {
    const before = stateWith([heading.create({ level: 2 }, schema.text("Hello"))], 2);
    const { state } = run(before, setHeading(2));
    expect(state.doc.firstChild!.type).toBe(paragraph);
  });

  it("switches level rather than toggling when the level differs", () => {
    const before = stateWith([heading.create({ level: 1 }, schema.text("Hello"))], 2);
    const { state } = run(before, setHeading(3));
    expect(state.doc.firstChild!.type).toBe(heading);
    expect(state.doc.firstChild!.attrs.level).toBe(3);
  });

  it("toggles the innermost heading, leaving its blockquote wrapper alone", () => {
    const before = stateWith(
      [blockquote.create(null, [heading.create({ level: 2 }, schema.text("Hi"))])],
      3,
    );
    const { state } = run(before, setHeading(2));
    expect(state.doc.firstChild!.type).toBe(blockquote);
    expect(state.doc.firstChild!.firstChild!.type).toBe(paragraph);
  });
});

describe("toggleLink", () => {
  it("is a no-op on an empty selection and never prompts", () => {
    const prompt = vi.spyOn(window, "prompt");
    const before = stateWith([paragraph.create(null, schema.text("Hello"))], 3);
    const { ok } = run(before, toggleLink);
    expect(ok).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("strips an existing link mark without prompting", () => {
    const prompt = vi.spyOn(window, "prompt");
    const text = schema.text("Hello", [link.create({ href: "https://a.example" })]);
    const before = stateWith([paragraph.create(null, text)], 1, 6);
    const { state, ok } = run(before, toggleLink);
    expect(ok).toBe(true);
    expect(state.doc.rangeHasMark(1, 6, link)).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts for a URL and applies it over the selection", () => {
    vi.spyOn(window, "prompt").mockReturnValue("https://b.example");
    const before = stateWith([paragraph.create(null, schema.text("Hello"))], 1, 6);
    const { state, ok } = run(before, toggleLink);
    expect(ok).toBe(true);
    expect(state.doc.rangeHasMark(1, 6, link)).toBe(true);
    expect(state.doc.nodeAt(1)!.marks[0].attrs.href).toBe("https://b.example");
  });

  it("changes nothing when the prompt is dismissed", () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    const before = stateWith([paragraph.create(null, schema.text("Hello"))], 1, 6);
    const { state, ok } = run(before, toggleLink);
    expect(ok).toBe(false);
    expect(state).toBe(before);
  });

  it("stays silent when probed without a dispatch", () => {
    const prompt = vi.spyOn(window, "prompt");
    const before = stateWith([paragraph.create(null, schema.text("Hello"))], 1, 6);
    expect(toggleLink(before)).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("startWikiLink", () => {
  it("inserts the `[[` the suggest plugin triggers on", () => {
    const before = stateWith([paragraph.create(null, schema.text("see "))], 5);
    const { state, ok } = run(before, startWikiLink);
    expect(ok).toBe(true);
    expect(state.doc.textContent).toBe("see [[");
  });

  it("reports true without dispatching when probed", () => {
    const before = stateWith([paragraph.create()], 1);
    expect(startWikiLink(before)).toBe(true);
  });
});
