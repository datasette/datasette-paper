import { describe, it, expect } from "vitest";
import { EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { schema } from "../schema";
import {
  tagKey,
  tagSuggestPlugin,
  moveTagSelection,
  setTagResults,
  commitTagSelection,
  type TagResult,
  type TagState,
} from "../tagSuggest";

function freshState(): EditorState {
  return EditorState.create({ schema, plugins: [tagSuggestPlugin] });
}

function ts(state: EditorState): TagState {
  return tagKey.getState(state)!;
}

function type(state: EditorState, text: string): EditorState {
  return state.apply(state.tr.insertText(text));
}

function backspace(state: EditorState, n = 1): EditorState {
  const pos = state.selection.from;
  return state.apply(state.tr.delete(pos - n, pos));
}

/** Minimal view stub that applies dispatched transactions in place. */
function viewStub(initial: EditorState) {
  const v = {
    state: initial,
    dispatch(tr: Transaction) {
      v.state = v.state.apply(tr);
    },
  };
  return v;
}

const RESULTS: TagResult[] = [
  { tag: "roadmap" },
  { tag: "research" },
  { tag: "retro" },
];

/** Count tag atoms in the doc and return the first one's slug. */
function tagNodes(state: EditorState): string[] {
  const out: string[] = [];
  state.doc.descendants((node) => {
    if (node.type.name === "tag") out.push(node.attrs.tag as string);
  });
  return out;
}

describe("tagSuggest plugin state", () => {
  it("activates on `#ro` at start of paragraph", () => {
    let state = freshState();
    state = type(state, "#ro");
    const t = ts(state);
    expect(t.active).toBe(true);
    expect(t.query).toBe("ro");
    expect(t.from).toBe(state.selection.from - 3);
  });

  it("activates after a space, pointing `from` at the `#`", () => {
    let state = freshState();
    state = type(state, "our #ro");
    const t = ts(state);
    expect(t.active).toBe(true);
    expect(t.query).toBe("ro");
    expect(t.from).toBe(state.selection.from - 3);
    expect(state.doc.textBetween(t.from, t.from + 1)).toBe("#");
  });

  it("does NOT activate when `#` follows a non-space char (mid-word)", () => {
    let state = freshState();
    state = type(state, "c#sharp");
    expect(ts(state).active).toBe(false);
  });

  it("extends and shrinks the query as you type and backspace", () => {
    let state = freshState();
    state = type(state, "#ro");
    expect(ts(state).query).toBe("ro");
    state = type(state, "ad");
    expect(ts(state).query).toBe("road");
    state = backspace(state);
    expect(ts(state).query).toBe("roa");
    expect(ts(state).active).toBe(true);
  });

  it("deactivates when the `#` is removed", () => {
    let state = freshState();
    state = type(state, "#ro");
    expect(ts(state).active).toBe(true);
    state = backspace(state, 3);
    expect(ts(state).active).toBe(false);
  });

  it("setTagResults + moveTagSelection clamps the index", () => {
    const view = viewStub(type(freshState(), "#r"));
    setTagResults(view as unknown as EditorView, RESULTS);
    expect(ts(view.state).results).toHaveLength(3);

    // Move down past the end clamps to the last index.
    for (let i = 0; i < 5; i++) {
      moveTagSelection(1)(view.state, view.dispatch);
    }
    expect(ts(view.state).index).toBe(2);
    moveTagSelection(-1)(view.state, view.dispatch);
    expect(ts(view.state).index).toBe(1);
  });
});

describe("tagSuggest commit", () => {
  it("commits the highlighted suggestion as a tag node", () => {
    const view = viewStub(type(freshState(), "#ro"));
    setTagResults(view as unknown as EditorView, RESULTS);
    // index 0 → "roadmap"
    commitTagSelection()(view.state, view.dispatch);
    expect(tagNodes(view.state)).toEqual(["roadmap"]);
    // The `#ro` typing span was replaced; popup is inactive.
    expect(ts(view.state).active).toBe(false);
  });

  it("commits the typed query as a brand-new tag when there are no matches", () => {
    const view = viewStub(type(freshState(), "#novel"));
    // No setTagResults → empty results; commit falls back to the query slug.
    commitTagSelection()(view.state, view.dispatch);
    expect(tagNodes(view.state)).toEqual(["novel"]);
  });

  it("lowercases the typed slug on free-form commit", () => {
    const view = viewStub(type(freshState(), "#Roadmap"));
    commitTagSelection()(view.state, view.dispatch);
    expect(tagNodes(view.state)).toEqual(["roadmap"]);
  });
});
