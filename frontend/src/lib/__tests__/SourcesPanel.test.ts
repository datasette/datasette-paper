/**
 * SourcesPanel tests. Real mount via @testing-library/svelte. A fake
 * EditorView wraps a real EditorState so dispatched transactions actually
 * apply, letting us assert the resulting doc. `sqlQuery` is mocked (db list +
 * probe).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

// Keep the SQL field on its textarea fallback: the real CmSqlField.create
// resolves at a nondeterministic point mid-test (dynamic imports), yanking
// the textarea these tests type into. The CM field itself is covered by
// cmSqlField.test.ts.
vi.mock("../cmSqlField", () => ({
  CmSqlField: { create: () => new Promise(() => {}) },
}));

vi.mock("../sqlQuery", async () => {
  const actual = await vi.importActual<typeof import("../sqlQuery")>("../sqlQuery");
  return {
    ...actual,
    listQueryableDatabases: vi.fn(async () => ["data", "analytics"]),
    runSqlQuery: vi.fn(async () => ({
      status: "ok",
      columns: ["total", "n"],
      rows: [[42, 7]],
    })),
  };
});

import { schema } from "../schema";
import { listQueryableDatabases } from "../sqlQuery";
import SourcesPanel from "../SourcesPanel.svelte";

function sourceNode(name: string | null, db: string, sql: string) {
  return schema.nodes.source.create({ name, db }, sql ? [schema.text(sql)] : []);
}

/** A fake EditorView backed by a mutable real EditorState. */
function makeView(blocks: ReturnType<typeof sourceNode>[]): {
  view: EditorView;
  countSources: () => number;
  names: () => (string | null)[];
} {
  const doc = schema.node("doc", null, [...blocks, schema.node("paragraph")]);
  let state = EditorState.create({ doc, schema });
  const view = {
    get state() {
      return state;
    },
    dispatch: (tr: import("prosemirror-state").Transaction) => {
      state = state.apply(tr);
    },
    focus() {},
  } as unknown as EditorView;
  const collect = () => {
    const out: (string | null)[] = [];
    state.doc.descendants((n) => {
      if (n.type.name === "source") out.push(n.attrs.name ?? null);
    });
    return out;
  };
  return { view, countSources: () => collect().length, names: collect };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function open(): Promise<void> {
  await fireEvent.click(screen.getByRole("button", { name: /sources/i }));
}

describe("SourcesPanel", () => {
  it("lists existing sources by name when opened", async () => {
    const { view } = makeView([sourceNode("revenue", "data", "select 1 as total")]);
    render(SourcesPanel, { view });
    await open();
    expect(screen.getByText("revenue")).toBeTruthy();
  });

  it("flags duplicate source names", async () => {
    const { view } = makeView([
      sourceNode("revenue", "data", "q1"),
      sourceNode("revenue", "data", "q2"),
    ]);
    render(SourcesPanel, { view });
    await open();
    // Both colliding rows get the warning.
    expect(screen.getAllByTitle("Duplicate source name")).toHaveLength(2);
  });

  it("Add → Save inserts a normalized source node", async () => {
    const v = makeView([]);
    render(SourcesPanel, { view: v.view });
    await open();
    await fireEvent.click(screen.getByText("+ Add source"));
    await fireEvent.input(screen.getByPlaceholderText("revenue"), {
      target: { value: "Net Revenue!" },
    });
    await fireEvent.input(screen.getByPlaceholderText(/select/), {
      target: { value: "select 1 as total" },
    });
    await fireEvent.click(screen.getByText("Save"));
    expect(v.countSources()).toBe(1);
    expect(v.names()).toEqual(["net_revenue"]);
  });

  it("Delete asks for confirmation before removing the source node", async () => {
    const v = makeView([sourceNode("revenue", "data", "q")]);
    render(SourcesPanel, { view: v.view });
    await open();
    // Arming the trash icon shows a confirmation; nothing is deleted yet.
    await fireEvent.click(screen.getByRole("button", { name: "Delete source" }));
    expect(v.countSources()).toBe(1);
    // Confirming removes it.
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(v.countSources()).toBe(0);
  });

  it("saves the same source after another edit shifts it to a new position", async () => {
    const first = sourceNode("first", "data", "select 1");
    const target = sourceNode("target", "data", "select 2");
    const v = makeView([first, target]);
    render(SourcesPanel, { view: v.view });
    await open();
    await fireEvent.click(screen.getAllByRole("button", { name: "Edit source" })[1]);
    await fireEvent.input(screen.getByPlaceholderText("revenue"), { target: { value: "edited" } });
    v.view.dispatch(v.view.state.tr.insertText(" + 100", 2));
    await fireEvent.click(screen.getByText("Save"));
    expect(v.names()).toEqual(["first", "edited"]);
    expect(v.view.state.doc.child(0).textContent).toBe("s + 100elect 1");
  });

  it("preserves the draft when a collaborator removes the source and shortens the document", async () => {
    const v = makeView([
      sourceNode("first", "data", "select something_long"),
      sourceNode("target", "data", "select 2"),
    ]);
    render(SourcesPanel, { view: v.view });
    await open();
    await fireEvent.click(screen.getAllByRole("button", { name: "Edit source" })[1]);
    await fireEvent.input(screen.getByPlaceholderText("revenue"), { target: { value: "my draft" } });
    v.view.dispatch(v.view.state.tr.replaceWith(0, v.view.state.doc.content.size, schema.node("paragraph")));
    await fireEvent.click(screen.getByText("Save"));
    expect(v.countSources()).toBe(0);
    expect(screen.getByRole("alert").textContent).toMatch(/changed or was removed/);
    expect((screen.getByPlaceholderText("revenue") as HTMLInputElement).value).toBe("my draft");
  });

  it("does not overwrite a source that a collaborator changed while its form was open", async () => {
    const v = makeView([sourceNode("target", "data", "select 2")]);
    render(SourcesPanel, { view: v.view });
    await open();
    await fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    v.view.dispatch(v.view.state.tr.insertText(" + 100", 9));
    await fireEvent.click(screen.getByText("Save"));
    expect(v.view.state.doc.firstChild!.textContent).toBe("select 2 + 100");
    expect(screen.getByRole("alert").textContent).toMatch(/changed or was removed/);
  });

  it("keeps delete confirmation on the same source when an earlier source disappears", async () => {
    const first = sourceNode("first", "data", "select 1");
    const v = makeView([first, sourceNode("target", "data", "select 2")]);
    render(SourcesPanel, { view: v.view });
    await open();
    await fireEvent.click(screen.getAllByRole("button", { name: "Delete source" })[1]);
    v.view.dispatch(v.view.state.tr.delete(0, first.nodeSize));
    await vi.waitFor(() => expect(screen.getAllByRole("button", { name: "Edit source" })).toHaveLength(1));
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(v.countSources()).toBe(0);
  });

  it("does not transfer delete confirmation to a source replacing the deleted target", async () => {
    const first = sourceNode("first", "data", "select 1");
    const v = makeView([first, sourceNode("keep", "data", "select 2")]);
    render(SourcesPanel, { view: v.view });
    await open();
    await fireEvent.click(screen.getAllByRole("button", { name: "Delete source" })[0]);
    v.view.dispatch(v.view.state.tr.delete(0, first.nodeSize));
    await vi.waitFor(() => expect(screen.getAllByRole("button", { name: "Edit source" })).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(v.names()).toEqual(["keep"]);
  });

  it("keeps a row mounted when an edit above it shifts its position", async () => {
    const v = makeView([
      sourceNode("first", "data", "select 1"),
      sourceNode("target", "data", "select 2"),
    ]);
    render(SourcesPanel, { view: v.view });
    await open();
    const row = screen.getByText("target").closest("li")!;
    v.view.dispatch(v.view.state.tr.insert(0, sourceNode("added", "data", "select 0")));
    await vi.waitFor(() => expect(screen.getAllByRole("button", { name: "Edit source" })).toHaveLength(3));
    expect(screen.getByText("target").closest("li")).toBe(row);
  });

  it("renders one row per occurrence when a source node object is reused", async () => {
    const shared = sourceNode("shared", "data", "select 1");
    const v = makeView([shared, shared]);
    render(SourcesPanel, { view: v.view });
    await open();
    expect(screen.getAllByRole("button", { name: "Edit source" })).toHaveLength(2);
  });

  it("shows how many times each source is used", async () => {
    const value = schema.nodes.value.create({
      source: "revenue",
      column: "total",
      format: null,
    });
    const doc = schema.node("doc", null, [
      sourceNode("revenue", "data", "select 1 as total"),
      sourceNode("costs", "data", "select 2 as c"),
      schema.node("paragraph", null, [value]),
    ]);
    const state = EditorState.create({ doc, schema });
    const view = {
      get state() {
        return state;
      },
      dispatch() {},
      focus() {},
    } as unknown as EditorView;
    render(SourcesPanel, { view });
    await open();
    // `revenue` is referenced once; `costs` by nothing.
    expect(screen.getByText("Used 1 time")).toBeTruthy();
    expect(screen.getByText("Not used")).toBeTruthy();
  });

  it("shows the column count from the store as 'N values, used N times'", async () => {
    const value = schema.nodes.value.create({
      source: "revenue",
      column: "total",
      format: null,
    });
    const doc = schema.node("doc", null, [
      sourceNode("revenue", "data", "select 1 as total, 2 as n"),
      schema.node("paragraph", null, [value]),
    ]);
    const state = EditorState.create({ doc, schema });
    const view = {
      get state() {
        return state;
      },
      dispatch() {},
      focus() {},
    } as unknown as EditorView;
    // Fake store: `revenue` resolves to two columns.
    const sourceStore = {
      subscribe(name: string, cb: (s: unknown) => void) {
        cb(
          name === "revenue"
            ? { status: "ok", columns: ["total", "n"], row: [1, 2] }
            : { status: "missing" },
        );
        return () => {};
      },
    } as unknown as import("../sourceStore").SourceStore;
    render(SourcesPanel, { view, sourceStore });
    await open();
    await vi.waitFor(() =>
      expect(screen.getByText("2 values, used 1 time")).toBeTruthy(),
    );
  });

  it("fetches the db list exactly once even when it comes back empty", async () => {
    // Regression: guarding the fetch on `dbs.length === 0` re-armed forever
    // when `/.json` exposes no queryable database — each empty result reassigns
    // `dbs = []`, which Svelte re-runs the effect on, hammering `/.json`.
    vi.mocked(listQueryableDatabases).mockResolvedValue([]);
    const { view } = makeView([]);
    render(SourcesPanel, { view });
    await open();
    // Let the resolved-empty assignment settle across several frames.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(listQueryableDatabases).toHaveBeenCalledTimes(1);
  });

  it("Test runs the query and shows the probed columns", async () => {
    const v = makeView([]);
    render(SourcesPanel, { view: v.view });
    await open();
    await fireEvent.click(screen.getByText("+ Add source"));
    await fireEvent.input(screen.getByPlaceholderText(/select/), {
      target: { value: "select 1 as total, 2 as n" },
    });
    await fireEvent.click(screen.getByText("Test"));
    await vi.waitFor(() => expect(screen.getByText(/2 columns: total, n/)).toBeTruthy());
  });
});
