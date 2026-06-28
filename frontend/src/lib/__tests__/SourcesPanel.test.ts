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

  it("Delete removes the source node", async () => {
    const v = makeView([sourceNode("revenue", "data", "q")]);
    render(SourcesPanel, { view: v.view });
    await open();
    await fireEvent.click(screen.getByText("Delete"));
    expect(v.countSources()).toBe(0);
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
