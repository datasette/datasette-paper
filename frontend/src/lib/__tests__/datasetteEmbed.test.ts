/**
 * Tests for the block_embed insert command + native-JSON fetch helpers.
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
  iconMarkup,
  embedIconMarkup,
  safeHref,
} from "../datasetteEmbed";
import { TOOLBAR_ICONS } from "../icons";

function emptyState(): EditorState {
  const doc = schema.node("doc", null, [schema.node("paragraph")]);
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.atStart(state.doc)));
}

describe("safeHref", () => {
  it("passes relative paths and http(s) URLs through", () => {
    expect(safeHref("/data/vendors")).toBe("/data/vendors");
    expect(safeHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHref("http://example.com")).toBe("http://example.com");
  });

  it("collapses dangerous schemes to '#'", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref("JavaScript:alert(1)")).toBe("#");
    expect(safeHref("data:text/html,<script>")).toBe("#");
    expect(safeHref("vbscript:msgbox(1)")).toBe("#");
    expect(safeHref(undefined)).toBe("#");
    expect(safeHref("")).toBe("#");
  });

  it("allows protocol-relative http(s) URLs (off-site nav, not XSS)", () => {
    // `//host` resolves to an http(s) navigation — no worse than a normal link.
    expect(safeHref("//example.com")).toBe("//example.com");
  });
});

describe("insertDatasetteEmbed", () => {
  it("inserts a block_embed node with ref + mode", () => {
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
    expect(inserted.type.name).toBe("block_embed");
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

describe("iconMarkup", () => {
  it("wraps a bundled icon's inner paths in a 16-viewBox svg", () => {
    const m = iconMarkup("database");
    expect(m.startsWith("<svg")).toBe(true);
    expect(m).toContain('viewBox="0 0 16 16"');
    expect(m).toContain(TOOLBAR_ICONS.database);
  });

  it("still emits a valid (empty) svg for an unknown name", () => {
    expect(iconMarkup("no-such-icon")).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"></svg>',
    );
  });
});

describe("embedIconMarkup", () => {
  it("returns a provider's raw svg verbatim (not sanitized, not re-wrapped)", () => {
    const svg = '<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>';
    expect(
      embedIconMarkup({ status: "ok", kind: "playlist", label: "x", href: "/x", icon: svg }),
    ).toBe(svg);
  });

  it("falls back to the wrapped kind icon when the provider sets no icon", () => {
    const m = embedIconMarkup({ status: "ok", kind: "database", label: "x", href: "/x" });
    expect(m).toContain("<svg");
    expect(m).toContain(TOOLBAR_ICONS.database);
  });

  it("uses the generic table icon for an unknown kind with no icon", () => {
    const m = embedIconMarkup({ status: "ok", kind: "playlist", label: "x", href: "/x" });
    expect(m).toContain(TOOLBAR_ICONS.table);
  });
});

describe("fetchEmbed (native .json)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("transforms a native table response into a table payload", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            columns: ["id", "name"],
            rows: [[1, "Acme"]],
            count: 30,
            next: "cursor",
          }),
        };
      }),
    );
    const out = await fetchEmbed("/d/t", 25);
    expect(urls[0]).toBe("/d/t.json?_shape=arrays&_extra=count,columns&_size=25");
    expect(out).toEqual({
      status: "ok",
      kind: "table",
      label: "t",
      db: "d",
      columns: ["id", "name"],
      rows: [[1, "Acme"]],
      count: 30,
      truncated: true,
      href: "/d/t",
    });
  });

  it("transforms a native row response into a row payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ columns: ["id", "name"], rows: [{ id: 1, name: "Acme" }] }),
      })),
    );
    expect(await fetchEmbed("/d/t/1")).toEqual({
      status: "ok",
      kind: "row",
      label: "1",
      db: "d",
      table: "t",
      pk: "1",
      fields: [
        { column: "id", value: 1 },
        { column: "name", value: "Acme" },
      ],
      href: "/d/t/1",
    });
  });

  it("transforms a native database response into a table listing, hiding plugin tables", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tables: [
            { name: "vendors", count: 30 },
            { name: "_datasette_paper_doc", count: 5 },
          ],
          views: [{ name: "v1" }],
        }),
      })),
    );
    expect(await fetchEmbed("/d")).toEqual({
      status: "ok",
      kind: "database",
      label: "d",
      db: "d",
      href: "/d",
      tables: [
        { name: "vendors", kind: "table", ref: "/d/vendors", href: "/d/vendors", count: 30 },
        { name: "v1", kind: "view", ref: "/d/v1", href: "/d/v1" },
      ],
    });
  });

  it("maps a 403 to denied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })),
    );
    expect(await fetchEmbed("/d/t")).toEqual({ status: "denied" });
  });

  it("maps any other non-ok to not_found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    expect(await fetchEmbed("/d/t")).toEqual({ status: "not_found" });
  });

  it("returns not_found when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    expect(await fetchEmbed("/d/t")).toEqual({ status: "not_found" });
  });
});

describe("searchResources (native enumeration)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("enumerates /.json + per-db /<db>.json and filters by name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/.json") {
          return { ok: true, json: async () => ({ databases: { data: {}, _internal: {} } }) };
        }
        if (url === "/data.json") {
          return {
            ok: true,
            json: async () => ({ tables: [{ name: "vendors" }, { name: "orders" }], views: [] }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    // `_internal` is `_`-prefixed → never enumerated; "orders" doesn't match.
    expect(await searchResources("vend")).toEqual([
      { ref: "/data/vendors", kind: "table", label: "vendors", db: "data" },
    ]);
  });

  it("returns [] when /.json is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await searchResources("x")).toEqual([]);
  });
});
