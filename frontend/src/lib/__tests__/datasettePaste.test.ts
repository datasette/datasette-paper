/**
 * Tests for context-aware Datasette URL paste: ref parsing, surface choice,
 * and the paste handler's inline-vs-block insertion.
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import {
  parseDatasetteRef,
  chooseDatasetteSurface,
  handleDatasettePaste,
} from "../datasettePaste";

const ORIGIN = "http://localhost";
const ctx = { origin: ORIGIN };

describe("parseDatasetteRef", () => {
  it("accepts same-origin db / table / row paths", () => {
    expect(parseDatasetteRef(`${ORIGIN}/fixtures`, ctx)).toBe("/fixtures");
    expect(parseDatasetteRef(`${ORIGIN}/fixtures/facetable`, ctx)).toBe(
      "/fixtures/facetable",
    );
    expect(parseDatasetteRef(`${ORIGIN}/fixtures/facetable/42`, ctx)).toBe(
      "/fixtures/facetable/42",
    );
  });

  it("accepts an absolute path (no origin)", () => {
    expect(parseDatasetteRef("/fixtures/facetable", ctx)).toBe(
      "/fixtures/facetable",
    );
  });

  it("strips a query string and trailing slash", () => {
    expect(parseDatasetteRef(`${ORIGIN}/fixtures/facetable/?_facet=x`, ctx)).toBe(
      "/fixtures/facetable",
    );
  });

  it("rejects external origins", () => {
    expect(parseDatasetteRef("https://evil.com/fixtures/facetable", ctx)).toBeNull();
  });

  it("rejects plain words and non-url text", () => {
    expect(parseDatasetteRef("facetable", ctx)).toBeNull();
    expect(parseDatasetteRef("just some text", ctx)).toBeNull();
    expect(parseDatasetteRef("", ctx)).toBeNull();
  });

  it("rejects tooling / plugin / static paths", () => {
    expect(parseDatasetteRef(`${ORIGIN}/-/paper/doc/1`, ctx)).toBeNull();
    expect(parseDatasetteRef(`${ORIGIN}/_internal/x`, ctx)).toBeNull();
  });

  it("rejects paths deeper than a row (4+ segments)", () => {
    expect(parseDatasetteRef(`${ORIGIN}/a/b/c/d`, ctx)).toBeNull();
  });

  it("honours a non-root base_url", () => {
    expect(
      parseDatasetteRef(`${ORIGIN}/data/fixtures/facetable`, {
        origin: ORIGIN,
        baseUrl: "/data/",
      }),
    ).toBe("/fixtures/facetable");
  });
});

// --- surface choice -------------------------------------------------------

function emptyParaState(): EditorState {
  const doc = schema.node("doc", null, [schema.node("paragraph")]);
  const s = EditorState.create({ doc });
  return s.apply(s.tr.setSelection(TextSelection.atStart(s.doc)));
}

function midTextState(): EditorState {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("hello world")]),
  ]);
  const s = EditorState.create({ doc });
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, 4)));
}

function listItemState(): EditorState {
  const doc = schema.node("doc", null, [
    schema.node("bullet_list", null, [
      schema.node("list_item", null, [schema.node("paragraph")]),
    ]),
  ]);
  const s = EditorState.create({ doc });
  return s.apply(s.tr.setSelection(TextSelection.atStart(s.doc)));
}

describe("chooseDatasetteSurface", () => {
  it("empty top paragraph + table ref → block", () => {
    expect(chooseDatasetteSurface(emptyParaState(), "/d/t")).toBe("block");
  });
  it("mid-text → inline", () => {
    expect(chooseDatasetteSurface(midTextState(), "/d/t")).toBe("inline");
  });
  it("database ref is always inline, even in an empty block", () => {
    expect(chooseDatasetteSurface(emptyParaState(), "/d")).toBe("inline");
  });
  it("nested context (list item) → inline", () => {
    expect(chooseDatasetteSurface(listItemState(), "/d/t")).toBe("inline");
  });
});

// --- paste handler --------------------------------------------------------

function fakeView(state: EditorState): {
  view: EditorView;
  getDoc: () => EditorState;
} {
  let current = state;
  const view = {
    get state() {
      return current;
    },
    dispatch(tr: import("prosemirror-state").Transaction) {
      current = current.apply(tr);
    },
  } as unknown as EditorView;
  return { view, getDoc: () => current };
}

function pasteEvent(text: string): ClipboardEvent {
  return {
    clipboardData: { getData: () => text },
  } as unknown as ClipboardEvent;
}

describe("handleDatasettePaste", () => {
  it("inserts a block embed when pasting a table URL in an empty block", () => {
    const { view, getDoc } = fakeView(emptyParaState());
    const claimed = handleDatasettePaste(view, pasteEvent("/fixtures/facetable"), ctx);
    expect(claimed).toBe(true);
    expect(getDoc().doc.firstChild!.type.name).toBe("datasette_embed");
    expect(getDoc().doc.firstChild!.attrs.ref).toBe("/fixtures/facetable");
  });

  it("inserts an inline ref when pasting a table URL mid-text", () => {
    const { view, getDoc } = fakeView(midTextState());
    const claimed = handleDatasettePaste(view, pasteEvent("/fixtures/facetable"), ctx);
    expect(claimed).toBe(true);
    const para = getDoc().doc.firstChild!;
    const types = [] as string[];
    para.forEach((n) => types.push(n.type.name));
    expect(types).toContain("datasette_ref");
  });

  it("inserts an inline ref for a row URL mid-text", () => {
    const { view, getDoc } = fakeView(midTextState());
    handleDatasettePaste(view, pasteEvent("/fixtures/vendors/42"), ctx);
    let found = false;
    getDoc().doc.firstChild!.forEach((n) => {
      if (n.type.name === "datasette_ref" && n.attrs.ref === "/fixtures/vendors/42") {
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it("falls through (returns false) for a non-Datasette URL", () => {
    const { view, getDoc } = fakeView(emptyParaState());
    const claimed = handleDatasettePaste(
      view,
      pasteEvent("https://example.com/page"),
      ctx,
    );
    expect(claimed).toBe(false);
    // Doc untouched (still an empty paragraph).
    expect(getDoc().doc.firstChild!.type.name).toBe("paragraph");
    expect(getDoc().doc.firstChild!.content.size).toBe(0);
  });
});
