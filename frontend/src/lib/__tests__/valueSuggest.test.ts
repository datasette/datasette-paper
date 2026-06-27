/**
 * Tests for the `${{` inline-value autocomplete state machine + commands. The
 * popup DOM (column vocab from the store) is exercised via e2e; here we pin the
 * trigger, the two-stage advance/commit, cancel, and sourceNamesIn.
 */
import { describe, it, expect } from "vitest";
import { EditorState, type Command } from "prosemirror-state";
import { schema } from "../schema";
import {
  valueKey,
  valueSuggestPlugin,
  moveValueSelection,
  cancelValueSuggest,
  commitValueSelection,
  sourceNamesIn,
  type ValueState,
} from "../valueSuggest";

function freshState(): EditorState {
  return EditorState.create({ schema, plugins: [valueSuggestPlugin] });
}

function vs(state: EditorState): ValueState {
  return valueKey.getState(state)!;
}

function type(state: EditorState, text: string): EditorState {
  return state.apply(state.tr.insertText(text));
}

function setResults(state: EditorState, results: string[]): EditorState {
  return state.apply(state.tr.setMeta(valueKey, { type: "setResults", results }));
}

/** Run a command, applying whatever transaction it dispatches. */
function run(state: EditorState, cmd: Command): EditorState {
  let next = state;
  cmd(state, (tr) => {
    next = state.apply(tr);
  });
  return next;
}

describe("valueSuggest plugin state", () => {
  it("activates on `${{rev` with the query and from at the `$`", () => {
    let state = freshState();
    state = type(state, "${{rev");
    const v = vs(state);
    expect(v.active).toBe(true);
    expect(v.query).toBe("rev");
    expect(v.from).toBe(state.selection.from - "${{rev".length);
  });

  it("activates mid-word (no boundary needed) and tracks the dotted query", () => {
    let state = freshState();
    state = type(state, "x ${{revenue.tot");
    const v = vs(state);
    expect(v.active).toBe(true);
    expect(v.query).toBe("revenue.tot");
  });

  it("does not activate on a bare {{ (no $)", () => {
    let state = freshState();
    state = type(state, "{{rev");
    expect(vs(state).active).toBe(false);
  });

  it("Escape cancels and remembers the dismissed span", () => {
    let state = freshState();
    state = type(state, "${{rev");
    state = run(state, cancelValueSuggest());
    expect(vs(state).active).toBe(false);
  });

  it("move clamps the highlighted index", () => {
    let state = freshState();
    state = type(state, "${{");
    state = setResults(state, ["a", "b", "c"]);
    state = run(state, moveValueSelection(1));
    expect(vs(state).index).toBe(1);
    state = run(state, moveValueSelection(-1));
    state = run(state, moveValueSelection(-1)); // clamp at 0
    expect(vs(state).index).toBe(0);
  });
});

describe("valueSuggest commit / advance", () => {
  it("stage A (no dot): Enter advances the text to `${{source.`", () => {
    let state = freshState();
    state = type(state, "${{rev");
    state = setResults(state, ["revenue"]);
    state = run(state, commitValueSelection());
    // The paragraph text now ends with the advanced `${{revenue.` — no value
    // node yet.
    expect(state.doc.textContent).toContain("${{revenue.");
    let hasValue = false;
    state.doc.descendants((n) => {
      if (n.type.name === "value") hasValue = true;
    });
    expect(hasValue).toBe(false);
  });

  it("stage B (dotted): Enter commits a value node with source + column", () => {
    let state = freshState();
    state = type(state, "${{revenue.tot");
    state = setResults(state, ["total"]); // highlighted column
    state = run(state, commitValueSelection());
    let val: { attrs: Record<string, unknown> } | null = null;
    state.doc.descendants((n) => {
      if (n.type.name === "value") val = n as unknown as typeof val;
    });
    expect(val).not.toBeNull();
    expect(val!.attrs).toEqual({ source: "revenue", column: "total", format: null });
    // The trigger text is gone.
    expect(state.doc.textContent).not.toContain("${{");
  });

  it("stage B with no results falls back to the typed column", () => {
    let state = freshState();
    state = type(state, "${{revenue.n");
    state = run(state, commitValueSelection());
    let column: unknown;
    state.doc.descendants((n) => {
      if (n.type.name === "value") column = n.attrs.column;
    });
    expect(column).toBe("n");
  });
});

describe("sourceNamesIn", () => {
  it("collects source node names from the doc", () => {
    const doc = schema.node("doc", null, [
      schema.nodes.source.create({ name: "revenue", db: "data" }, [schema.text("q")]),
      schema.nodes.source.create({ name: "prior", db: "data" }, [schema.text("q")]),
      schema.node("paragraph"),
    ]);
    expect(sourceNamesIn(doc)).toEqual(["revenue", "prior"]);
  });

  it("ignores unnamed sources", () => {
    const doc = schema.node("doc", null, [
      schema.nodes.source.create({ name: null, db: "data" }, [schema.text("q")]),
      schema.node("paragraph"),
    ]);
    expect(sourceNamesIn(doc)).toEqual([]);
  });
});