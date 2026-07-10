// @feat source: tests source card render + setNodeMarkup on name edit
/**
 * NodeView tests for `source`: the card renders name + db + SQL editor + a
 * column probe (no results table); editing the name dispatches a setNodeMarkup;
 * the probe reflects the store state (XSS-safe); the collapse toggle hides the
 * SQL.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import { SourceBlockView } from "../sourceBlockView";
import type { SourceStore, SourceState } from "../sourceStore";

function stubDbList() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/.json")) {
        return { ok: true, status: 200, json: async () => ({ databases: [{ name: "data" }] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
}

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

async function build(
  attrs: { name?: string | null; db?: string | null },
  state: SourceState,
) {
  stubDbList();
  const dispatched: { attrs: Record<string, unknown> }[] = [];
  const node = schema.nodes.source.create(
    { name: attrs.name ?? null, db: attrs.db ?? "data" },
    [schema.text("select count(*) as n from t")],
  );
  const view = new SourceBlockView(node, fakeView(dispatched), () => 0, fakeStore(state));
  await new Promise((r) => setTimeout(r, 0));
  return { view, dispatched };
}

const ok = (columns: string[]): SourceState => ({ status: "ok", columns, row: null });

describe("SourceBlockView", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders a name input, db select, and editable SQL contentDOM", async () => {
    const { view } = await build({ name: "revenue" }, ok(["n"]));
    const name = view.dom.querySelector(".pm-source-card-name") as HTMLInputElement;
    expect(name.value).toBe("revenue");
    expect(view.dom.querySelector(".pm-source-card-db")).not.toBeNull();
    expect(view.contentDOM!.tagName).toBe("CODE");
    // No results table — that's what separates it from sql_block.
    expect(view.dom.querySelector("table")).toBeNull();
  });

  it("probe lists the source's columns from the store", async () => {
    const { view } = await build({ name: "revenue" }, ok(["total", "n"]));
    const probe = view.dom.querySelector(".pm-source-card-probe")!;
    expect(probe.textContent).toBe("2 columns: total, n");
  });

  it("probe shows an error state for a failed query (text-only, XSS-safe)", async () => {
    const { view } = await build(
      { name: "revenue" },
      { status: "error", error: "<b>no such table: t</b>" },
    );
    const probe = view.dom.querySelector(".pm-source-card-probe")!;
    expect(probe.className).toContain("is-error");
    expect(probe.children.length).toBe(0);
    expect(probe.textContent).toBe("<b>no such table: t</b>");
  });

  it("editing the name (blur) dispatches a normalized setNodeMarkup", async () => {
    const { view, dispatched } = await build({ name: "revenue" }, ok(["n"]));
    const name = view.dom.querySelector(".pm-source-card-name") as HTMLInputElement;
    name.value = "Net Revenue!";
    name.dispatchEvent(new Event("blur"));
    const markup = dispatched.find((d) => (d as { attrs?: { name?: string } }).attrs?.name);
    expect((markup as { attrs: { name: string } }).attrs.name).toBe("net_revenue");
  });

  it("renders collapsed as a pill by default; toggle expands the SQL editor", async () => {
    const { view } = await build({ name: "revenue" }, ok(["n"]));
    const toggle = view.dom.querySelector(".pm-source-card-toggle") as HTMLButtonElement;
    // Defaults collapsed now that the sidebar Sources panel is the primary editor.
    expect(view.dom.classList.contains("is-collapsed")).toBe(true);
    toggle.click();
    expect(view.dom.classList.contains("is-collapsed")).toBe(false);
  });

  it("grows the name input with its content so long names aren't clipped", async () => {
    const { view } = await build({ name: "short" }, ok(["n"]));
    const name = view.dom.querySelector(".pm-source-card-name") as HTMLInputElement;
    const initial = name.size;
    name.value = "entries_matching_transcript_search";
    name.dispatchEvent(new Event("input"));
    expect(name.size).toBeGreaterThan(initial);
    expect(name.size).toBeGreaterThanOrEqual("entries_matching_transcript_search".length);
  });

  it("prompts to name an unnamed source", async () => {
    const { view } = await build({ name: null }, { status: "missing" });
    const probe = view.dom.querySelector(".pm-source-card-probe")!;
    expect(probe.textContent).toContain("name this source");
  });
});
