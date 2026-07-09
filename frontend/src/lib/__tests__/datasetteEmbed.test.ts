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
  tildeEncode,
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
    expect(urls[0]).toBe(
      "/d/t.json?_shape=arrays&_extra=count,count_truncated,columns,primary_keys&_size=25",
    );
    expect(out).toEqual({
      status: "ok",
      kind: "table",
      label: "t",
      db: "d",
      columns: ["id", "name"],
      allColumns: ["id", "name"],
      primaryKeys: [],
      rows: [[1, "Acme"]],
      count: 30,
      countTruncated: false,
      truncated: true,
      href: "/d/t",
    });
  });

  it("sends _col= for each selected column and projects the response", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        // Server re-adds the PK `rowid` first even though it wasn't requested.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            columns: ["rowid", "name", "id"],
            rows: [[7, "Acme", 1]],
            count: 30,
            next: null,
          }),
        };
      }),
    );
    const out = await fetchEmbed("/d/t", 25, ["name", "id"]);
    // _col= is sent for each selected column (unselected ones stay server-side).
    expect(urls[0]).toContain("_col=name");
    expect(urls[0]).toContain("_col=id");
    expect(urls[0]).not.toContain("_col=rowid");
    // Projection drops the forced-in PK and applies the author's order.
    if (out.status !== "ok" || out.kind !== "table") throw new Error("expected table");
    expect(out.columns).toEqual(["name", "id"]);
    expect(out.rows).toEqual([["Acme", 1]]);
    // The full set is preserved for the picker.
    expect(out.allColumns).toEqual(["rowid", "name", "id"]);
  });

  it("issues no _col= and returns full columns when no selection is given", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ columns: ["id", "name"], rows: [[1, "Acme"]], count: 1 }),
        };
      }),
    );
    const out = await fetchEmbed("/d/t", 25);
    expect(urls[0]).not.toContain("_col=");
    if (out.status !== "ok" || out.kind !== "table") throw new Error("expected table");
    expect(out.columns).toEqual(["id", "name"]);
  });

  it("drops selected columns absent from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ columns: ["id", "name"], rows: [[1, "Acme"]], count: 1 }),
      })),
    );
    const out = await fetchEmbed("/d/t", 25, ["name", "gone"]);
    if (out.status !== "ok" || out.kind !== "table") throw new Error("expected table");
    expect(out.columns).toEqual(["name"]);
    expect(out.rows).toEqual([["Acme"]]);
  });

  it("falls back to the full response when every selected column has vanished", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ columns: ["id", "name"], rows: [[1, "Acme"]], count: 1 }),
      })),
    );
    const out = await fetchEmbed("/d/t", 25, ["nope", "alsonope"]);
    if (out.status !== "ok" || out.kind !== "table") throw new Error("expected table");
    expect(out.columns).toEqual(["id", "name"]);
    expect(out.rows).toEqual([[1, "Acme"]]);
  });

  // ── Filters + sort (config.filters / config.sort → query params) ─────────

  function stubTableFetch(urls: string[], init: { ok?: boolean; status?: number; body?: unknown } = {}) {
    const { ok = true, status = 200, body } = init;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return {
          ok,
          status,
          json: async () => body ?? { columns: ["id"], rows: [[1]], count: 1 },
        };
      }),
    );
  }

  it("appends column__op=value pairs and the sort param to the fetch URL", async () => {
    const urls: string[] = [];
    stubTableFetch(urls);
    await fetchEmbed(
      "/d/t",
      25,
      undefined,
      [
        { column: "state", op: "exact", value: "CA" },
        { column: "notes", op: "notblank" },
      ],
      { column: "population", desc: true },
    );
    const query = new URLSearchParams(urls[0].split("?")[1]);
    expect(query.get("state__exact")).toBe("CA");
    // No-value ops send "1", exactly what Datasette's cog menu emits.
    expect(query.get("notes__notblank")).toBe("1");
    expect(query.get("_sort_desc")).toBe("population");
    expect(query.get("_sort")).toBeNull();
    // The existing fetch-only params are still present, before the filters.
    expect(urls[0]).toContain("_shape=arrays");
    expect(urls[0]).toContain("_size=25");
  });

  it("emits _sort (not _sort_desc) for an ascending sort", async () => {
    const urls: string[] = [];
    stubTableFetch(urls);
    await fetchEmbed("/d/t", 25, undefined, [], { column: "name" });
    const query = new URLSearchParams(urls[0].split("?")[1]);
    expect(query.get("_sort")).toBe("name");
    expect(query.get("_sort_desc")).toBeNull();
  });

  it("keeps values with &, %, = and unicode as a single encoded param", async () => {
    const urls: string[] = [];
    stubTableFetch(urls);
    await fetchEmbed("/d/t", 25, undefined, [
      { column: "name", op: "exact", value: "CA&_del=1" },
      { column: "pct", op: "contains", value: "100%" },
      { column: "city", op: "exact", value: "Zürich ✓" },
    ]);
    const query = new URLSearchParams(urls[0].split("?")[1]);
    // The crafted value round-trips as ONE param — no smuggled `_del` key.
    expect(query.get("name__exact")).toBe("CA&_del=1");
    expect(query.get("_del")).toBeNull();
    expect(query.get("pct__contains")).toBe("100%");
    expect(query.get("city__exact")).toBe("Zürich ✓");
    // And the raw URL carries them percent-encoded.
    expect(urls[0]).toContain("name__exact=CA%26_del%3D1");
  });

  it("issues no filter/sort params when none are configured", async () => {
    const urls: string[] = [];
    stubTableFetch(urls);
    await fetchEmbed("/d/t", 25);
    expect(urls[0]).toBe(
      "/d/t.json?_shape=arrays&_extra=count,count_truncated,columns,primary_keys&_size=25",
    );
  });

  it("maps primary_keys into the payload, intersected with the columns shown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          columns: ["id", "name"],
          rows: [[1, "Acme"]],
          count: 1,
          // "ghost" is not among the columns → dropped by the intersect.
          primary_keys: ["id", "ghost"],
        }),
      })),
    );
    const out = await fetchEmbed("/d/t", 25);
    if (out.status !== "ok" || out.kind !== "table") throw new Error("expected table");
    expect(out.primaryKeys).toEqual(["id"]);
  });

  it("defaults primaryKeys to [] when the extra is absent (rowid table)", async () => {
    const urls: string[] = [];
    stubTableFetch(urls);
    const out = await fetchEmbed("/d/t", 25);
    if (out.status !== "ok" || out.kind !== "table") throw new Error("expected table");
    expect(out.primaryKeys).toEqual([]);
  });

  it("maps count_truncated=true from the response into the payload", async () => {
    const urls: string[] = [];
    stubTableFetch(urls, {
      body: { columns: ["id"], rows: [[1]], count: 10001, count_truncated: true },
    });
    const out = await fetchEmbed("/d/t", 25);
    if (out.status !== "ok" || out.kind !== "table") throw new Error("expected table");
    expect(out.countTruncated).toBe(true);
  });

  it("defaults countTruncated to false when the extra is absent", async () => {
    const urls: string[] = [];
    stubTableFetch(urls);
    const out = await fetchEmbed("/d/t", 25);
    if (out.status !== "ok" || out.kind !== "table") throw new Error("expected table");
    expect(out.countTruncated).toBe(false);
  });

  it("surfaces Datasette's error string from a 400 body", async () => {
    const urls: string[] = [];
    stubTableFetch(urls, {
      ok: false,
      status: 400,
      body: { ok: false, error: "Cannot sort table by nope" },
    });
    expect(
      await fetchEmbed("/d/t", 25, undefined, [], { column: "nope" }),
    ).toEqual({ status: "error", message: "Cannot sort table by nope" });
  });

  it("keeps a 403 leak-free (denied) even when the body has an error string", async () => {
    const urls: string[] = [];
    stubTableFetch(urls, {
      ok: false,
      status: 403,
      body: { ok: false, error: "Permission denied for secret_table" },
    });
    expect(await fetchEmbed("/d/t", 25)).toEqual({ status: "denied" });
  });

  it("falls back to not_found when a non-200 body has no error string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => {
          throw new Error("not json");
        },
      })),
    );
    expect(await fetchEmbed("/d/t", 25)).toEqual({ status: "not_found" });
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
          return {
            ok: true,
            json: async () => ({ databases: [{ name: "data" }, { name: "_internal" }] }),
          };
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

// @feat embed-pk-links: tilde-encoding matches datasette.utils.tilde_encode
describe("tildeEncode (row-pk path segments)", () => {
  // Golden vectors produced by datasette.utils.tilde_encode itself, so this
  // stays a faithful port: unreserved [A-Za-z0-9_-] pass through, space → "+",
  // every other byte → "~XX" (uppercase hex), multi-byte chars per UTF-8 byte.
  it.each([
    ["2", "2"],
    ["2020-01-01", "2020-01-01"],
    ["a_b-C9", "a_b-C9"],
    ["a/b", "a~2Fb"],
    ["hello world", "hello+world"],
    ["1.5", "1~2E5"],
    ["a,b", "a~2Cb"],
    ["~x", "~7Ex"],
    ["100%", "100~25"],
    ["café", "caf~C3~A9"],
    ["", ""],
  ])("encodes %o as %o", (input, expected) => {
    expect(tildeEncode(input)).toBe(expected);
  });
});
