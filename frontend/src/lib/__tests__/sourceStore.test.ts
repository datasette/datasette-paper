/**
 * Tests for the source store — the live, deduped query runner behind inline
 * value chips. `runSqlQuery` is mocked; we assert call-count (dedup / no
 * needless refetch), state mapping, and subscription semantics.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SqlResult } from "../sqlQuery";

vi.mock("../sqlQuery", () => ({ runSqlQuery: vi.fn() }));

import { runSqlQuery } from "../sqlQuery";
import { schema } from "../schema";
import { SourceStore, cellFor, type SourceState } from "../sourceStore";

const mockRun = runSqlQuery as unknown as ReturnType<typeof vi.fn>;

function docWithSources(sources: { name: string; db?: string; sql: string }[]) {
  const nodes = sources.map((s) =>
    schema.nodes.source.create({ name: s.name, db: s.db ?? "data" }, [schema.text(s.sql)]),
  );
  return schema.node("doc", null, [...nodes, schema.node("paragraph")]);
}

function ok(columns: string[], rows: unknown[][]): SqlResult {
  return { status: "ok", columns, rows: rows as never, truncated: false };
}

beforeEach(() => {
  mockRun.mockReset();
});

describe("SourceStore", () => {
  it("dedups: many subscribers on one source = one query", async () => {
    mockRun.mockResolvedValue(ok(["total"], [[42]]));
    const store = new SourceStore();
    const a: SourceState[] = [];
    const b: SourceState[] = [];
    store.subscribe("revenue", (s) => a.push(s));
    store.subscribe("revenue", (s) => b.push(s));

    store.sync(docWithSources([{ name: "revenue", sql: "select 42 as total" }]));

    await vi.waitFor(() => {
      expect(a.at(-1)).toMatchObject({ status: "ok" });
      expect(b.at(-1)).toMatchObject({ status: "ok" });
    });
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("maps ok with rows → {columns, row: rows[0]}", async () => {
    mockRun.mockResolvedValue(ok(["a", "b"], [[1, 2], [3, 4]]));
    const store = new SourceStore();
    let last: SourceState = { status: "missing" };
    store.subscribe("s", (s) => (last = s));
    store.sync(docWithSources([{ name: "s", sql: "q" }]));
    await vi.waitFor(() => expect(last.status).toBe("ok"));
    expect(last).toEqual({ status: "ok", columns: ["a", "b"], row: [1, 2] });
  });

  it("maps ok with no rows → row null", async () => {
    mockRun.mockResolvedValue(ok(["a"], []));
    const store = new SourceStore();
    let last: SourceState = { status: "missing" };
    store.subscribe("s", (s) => (last = s));
    store.sync(docWithSources([{ name: "s", sql: "q" }]));
    await vi.waitFor(() => expect(last.status).toBe("ok"));
    expect(last).toEqual({ status: "ok", columns: ["a"], row: null });
  });

  it("passes through denied and error", async () => {
    mockRun.mockResolvedValueOnce({ status: "denied" });
    const store = new SourceStore();
    let last: SourceState = { status: "missing" };
    store.subscribe("s", (s) => (last = s));
    store.sync(docWithSources([{ name: "s", sql: "q" }]));
    await vi.waitFor(() => expect(last.status).toBe("denied"));

    mockRun.mockResolvedValueOnce({ status: "error", error: "boom" });
    store.sync(docWithSources([{ name: "s", sql: "q2" }]));
    await vi.waitFor(() => expect(last).toEqual({ status: "error", error: "boom" }));
  });

  it("reports missing for an unknown source name", () => {
    const store = new SourceStore();
    let last: SourceState = { status: "ok", columns: [], row: null };
    store.subscribe("nope", (s) => (last = s));
    expect(last).toEqual({ status: "missing" });
  });

  it("marks subscribers missing when a source is deleted", async () => {
    mockRun.mockResolvedValue(ok(["total"], [[1]]));
    const store = new SourceStore();
    let last: SourceState = { status: "missing" };
    store.subscribe("revenue", (s) => (last = s));
    store.sync(docWithSources([{ name: "revenue", sql: "q" }]));
    await vi.waitFor(() => expect(last.status).toBe("ok"));

    store.sync(docWithSources([])); // source removed
    expect(last).toEqual({ status: "missing" });
  });

  it("does not refetch when (db, sql) is unchanged, but does when SQL changes", async () => {
    mockRun.mockResolvedValue(ok(["total"], [[1]]));
    const store = new SourceStore();
    store.subscribe("revenue", () => {});

    store.sync(docWithSources([{ name: "revenue", sql: "select 1" }]));
    await vi.waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));

    // Re-sync with a structurally different doc but the SAME source def.
    store.sync(docWithSources([{ name: "revenue", sql: "select 1" }]));
    expect(mockRun).toHaveBeenCalledTimes(1); // no refetch

    // Now change the SQL → refetch.
    store.sync(docWithSources([{ name: "revenue", sql: "select 2" }]));
    await vi.waitFor(() => expect(mockRun).toHaveBeenCalledTimes(2));
  });

  it("stops notifying after unsubscribe", async () => {
    mockRun.mockResolvedValue(ok(["total"], [[1]]));
    const store = new SourceStore();
    const seen: SourceState[] = [];
    const unsub = store.subscribe("revenue", (s) => seen.push(s));
    unsub();
    store.sync(docWithSources([{ name: "revenue", sql: "q" }]));
    await new Promise((r) => setTimeout(r, 0));
    // Only the immediate (pre-unsub) notification; nothing after.
    expect(seen).toEqual([{ status: "missing" }]);
  });

  it("cellFor resolves a column by name", () => {
    const state = { status: "ok" as const, columns: ["a", "b"], row: [10, 20] };
    expect(cellFor(state, "b")).toBe(20);
    expect(cellFor(state, "missing")).toBeUndefined();
    expect(cellFor({ status: "ok", columns: ["a"], row: null }, "a")).toBe(null);
  });
});
