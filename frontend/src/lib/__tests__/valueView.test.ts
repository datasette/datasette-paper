// @feat value: tests value render states off a fake SourceStore
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
import type { ValueFormat } from "../formatValue";

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

/** A view stub recording dispatched transactions (mirrors sqlBlockView.test). */
function fakeView(dispatched: unknown[]): EditorView {
  return {
    state: {
      tr: {
        setNodeMarkup: (_pos: number, _type: unknown, attrs: unknown) => ({ attrs }),
      },
    },
    dispatch: (tr: unknown) => dispatched.push(tr),
  } as unknown as EditorView;
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

  it("renders a formatted value through formatValue (currency)", () => {
    const view = buildView(
      { source: "revenue", column: "total", format: { kind: "currency", currency: "USD" } },
      okState(["total"], [1284.5]),
    );
    expect(view.dom.textContent).toBe("$1,284.50");
    // No element children when the popover is closed (XSS / no-HTML guarantee).
    expect(view.dom.children.length).toBe(0);
  });

  it("clicking the chip opens a popover with the source's columns + format kinds", () => {
    const view = buildView({ source: "revenue", column: "total" }, okState(["total", "n"], [1, 2]));
    expect(view.dom.querySelector(".pm-value-popover")).toBeNull();
    view.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const pop = view.dom.querySelector(".pm-value-popover");
    expect(pop).not.toBeNull();
    const selects = pop!.querySelectorAll("select");
    const colOpts = [...selects[0].options].map((o) => o.value);
    expect(colOpts).toEqual(["total", "n"]);
    const kindOpts = [...selects[1].options].map((o) => o.value);
    expect(kindOpts).toEqual(["", "number", "currency", "percent", "date", "text"]);
    // A second click toggles it shut.
    view.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view.dom.querySelector(".pm-value-popover")).toBeNull();
    view.destroy();
  });

  it("changing the format dispatches a setNodeMarkup with the new format + column", () => {
    const dispatched: unknown[] = [];
    const node = schema.nodes.value.create({ source: "revenue", column: "total", format: null });
    const view = new ValueView(node, fakeView(dispatched), () => 3, fakeStore(okState(["total"], [1])));
    view.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const pop = view.dom.querySelector(".pm-value-popover")!;
    const kindSel = pop.querySelectorAll("select")[1];
    kindSel.value = "currency";
    kindSel.dispatchEvent(new Event("change"));
    expect(dispatched).toHaveLength(1);
    const attrs = (dispatched[0] as { attrs: { column: string; format: ValueFormat } }).attrs;
    expect(attrs.column).toBe("total");
    expect(attrs.format).toEqual({ kind: "currency" });
    view.destroy();
  });

  it("typing into a format input commits ONE step on blur, not per keystroke", () => {
    const dispatched: unknown[] = [];
    const node = schema.nodes.value.create({ source: "revenue", column: "total", format: null });
    const view = new ValueView(node, fakeView(dispatched), () => 3, fakeStore(okState(["total"], [1])));
    view.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const pop = view.dom.querySelector(".pm-value-popover")!;

    // Choosing the currency kind commits once (a <select> change), and reveals
    // the currency text input.
    const kindSel = pop.querySelectorAll("select")[1];
    kindSel.value = "currency";
    kindSel.dispatchEvent(new Event("change"));
    expect(dispatched).toHaveLength(1);

    // Type three characters — none of these `input` events may dispatch.
    const curInput = pop.querySelector<HTMLInputElement>("[data-opt=currency]")!;
    for (const ch of ["U", "US", "USD"]) {
      curInput.value = ch;
      curInput.dispatchEvent(new Event("input"));
    }
    expect(dispatched).toHaveLength(1); // still just the kind-change step

    // Blur commits exactly one step carrying the full typed value.
    curInput.dispatchEvent(new Event("blur"));
    expect(dispatched).toHaveLength(2);
    const attrs = (dispatched[1] as { attrs: { format: ValueFormat } }).attrs;
    expect(attrs.format).toEqual({ kind: "currency", currency: "USD" });
    view.destroy();
  });

  it("pressing Enter in a format input commits one step (via blur)", () => {
    const dispatched: unknown[] = [];
    const node = schema.nodes.value.create({ source: "revenue", column: "total", format: null });
    const view = new ValueView(node, fakeView(dispatched), () => 3, fakeStore(okState(["total"], [1])));
    // jsdom only fires focus/blur for connected elements, and Enter commits by
    // blurring — so mount the chip in the document for this test.
    document.body.appendChild(view.dom);
    view.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const pop = view.dom.querySelector(".pm-value-popover")!;

    // Raw kind, custom fallback: typing dispatches nothing.
    const fbInput = pop.querySelector<HTMLInputElement>(".pm-value-popover-input")!;
    fbInput.focus();
    fbInput.value = "n/a";
    fbInput.dispatchEvent(new Event("input"));
    expect(dispatched).toHaveLength(0);

    // Enter blurs the input, which commits exactly once.
    fbInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(dispatched).toHaveLength(1);
    const attrs = (dispatched[0] as { attrs: { format: ValueFormat } }).attrs;
    expect(attrs.format).toEqual({ kind: "text", fallback: "n/a" });
    view.destroy();
    view.dom.remove();
  });
});
