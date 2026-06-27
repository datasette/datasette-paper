/**
 * Tests for ValueView — the inline-atom NodeView that renders a live SQL value
 * by subscribing to the SourceStore. A FAKE store emits a single state
 * synchronously so each render branch is asserted without fetch/timer
 * machinery.
 */
import { describe, it, expect } from "vitest";
import type { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import { ValueView } from "../valueView";
import type { SourceStore, SourceState } from "../sourceStore";

function fakeStore(state: SourceState): SourceStore {
  return {
    subscribe(_name: string, cb: (s: SourceState) => void) {
      cb(state);
      return () => {};
    },
    getState: () => state,
    sync() {},
  } as unknown as SourceStore;
}

function buildView(
  attrs: { source: string | null; column: string | null; format?: unknown },
  state: SourceState,
): ValueView {
  const node = schema.nodes.value.create(attrs);
  return new ValueView(node, {} as unknown as EditorView, () => 0, fakeStore(state));
}

const okState = (columns: string[], row: unknown[] | null): SourceState => ({
  status: "ok",
  columns,
  row: row as never,
});

describe("ValueView", () => {
  it("ok: renders the resolved cell, no modifier class", () => {
    const view = buildView(
      { source: "revenue", column: "total" },
      okState(["total", "n"], [1284902, 4317]),
    );
    expect(view.dom.textContent).toBe("1284902");
    expect(view.dom.className).toBe("pm-value");
  });

  it("ok with null cell: renders the fallback dash", () => {
    const view = buildView({ source: "s", column: "a" }, okState(["a"], [null]));
    expect(view.dom.textContent).toBe("—");
  });

  it("ok with no rows: renders the fallback dash", () => {
    const view = buildView({ source: "s", column: "a" }, okState(["a"], null));
    expect(view.dom.textContent).toBe("—");
  });

  it("loading: shows an ellipsis with the loading class", () => {
    const view = buildView({ source: "s", column: "a" }, { status: "loading" });
    expect(view.dom.textContent).toBe("…");
    expect(view.dom.className).toContain("pm-value--loading");
  });

  it("missing source: error chip naming the source", () => {
    const view = buildView({ source: "ghost", column: "a" }, { status: "missing" });
    expect(view.dom.textContent).toBe("${{?ghost}}");
    expect(view.dom.className).toContain("pm-value--error");
  });

  it("missing column: error chip naming source.column", () => {
    const view = buildView(
      { source: "revenue", column: "nope" },
      okState(["total"], [1]),
    );
    expect(view.dom.textContent).toBe("${{revenue.nope}}");
    expect(view.dom.className).toContain("pm-value--error");
  });

  it("denied: leak-free no-access chip", () => {
    const view = buildView({ source: "s", column: "a" }, { status: "denied" });
    expect(view.dom.textContent).toBe("no access");
    expect(view.dom.className).toContain("pm-value--denied");
  });

  it("error: error chip with the message as title", () => {
    const view = buildView(
      { source: "s", column: "a" },
      { status: "error", error: "no such table: t" },
    );
    expect(view.dom.textContent).toBe("error");
    expect(view.dom.title).toBe("no such table: t");
  });

  it("renders DB content as text, never HTML (XSS)", () => {
    const view = buildView(
      { source: "s", column: "a" },
      okState(["a"], ['<img src=x onerror="alert(1)">']),
    );
    expect(view.dom.children.length).toBe(0);
    expect(view.dom.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it("is an atom NodeView that owns its DOM", () => {
    const view = buildView({ source: "s", column: "a" }, okState(["a"], [1]));
    expect(view.ignoreMutation()).toBe(true);
    expect(view.stopEvent()).toBe(false);
  });
});
