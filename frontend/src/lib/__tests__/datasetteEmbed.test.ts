/**
 * Tests for the datasette_embed insert command + fetch helpers.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";

import { schema } from "../schema";
import {
  insertDatasetteEmbed,
  fetchEmbed,
  searchResources,
  cellText,
  kindIcon,
} from "../datasetteEmbed";

function emptyState(): EditorState {
  const doc = schema.node("doc", null, [schema.node("paragraph")]);
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.atStart(state.doc)));
}

describe("insertDatasetteEmbed", () => {
  it("inserts a datasette_embed node with ref + mode", () => {
    const state = emptyState();
    let next = state;
    const ok = insertDatasetteEmbed("/fixtures/facetable", "table")(
      state,
      (tr) => {
        next = state.apply(tr);
      },
    );
    expect(ok).toBe(true);
    const inserted = next.doc.firstChild!;
    expect(inserted.type.name).toBe("datasette_embed");
    expect(inserted.attrs.ref).toBe("/fixtures/facetable");
    expect(inserted.attrs.mode).toBe("table");
  });

  it("defaults mode to table", () => {
    const state = emptyState();
    let next = state;
    insertDatasetteEmbed("/fixtures/facetable")(state, (tr) => {
      next = state.apply(tr);
    });
    expect(next.doc.firstChild!.attrs.mode).toBe("table");
  });
});

describe("cellText + kindIcon", () => {
  it("formats scalars and blob envelopes as text", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(42)).toBe("42");
    expect(cellText("hi")).toBe("hi");
    expect(cellText({ $base64: true, encoded: "AA==" })).toBe("[binary]");
  });

  it("maps kinds to icons", () => {
    expect(kindIcon("database")).toBe("database");
    expect(kindIcon("view")).toBe("eye");
    expect(kindIcon("row")).toBe("fileText");
    expect(kindIcon("table")).toBe("table");
    expect(kindIcon(undefined)).toBe("table");
  });
});

describe("fetchEmbed / searchResources", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the payload on ok", async () => {
    const payload = { status: "ok", kind: "table", label: "t", db: "d", columns: [], rows: [], count: 0, truncated: false, href: "/d/t" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => payload })),
    );
    const out = await fetchEmbed("/d/t", 25);
    expect(out).toEqual(payload);
  });

  it("returns not_found on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await fetchEmbed("/d/t")).toEqual({ status: "not_found" });
  });

  it("returns not_found when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    expect(await fetchEmbed("/d/t")).toEqual({ status: "not_found" });
  });

  it("search returns results array, [] on error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ results: [{ ref: "/d/t", kind: "table", label: "t", db: "d" }] }) })),
    );
    expect(await searchResources("t")).toHaveLength(1);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await searchResources("t")).toEqual([]);
  });
});
