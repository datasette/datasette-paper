// @feat sql-block: tests auto-run, 403 leak discipline, XSS, hidden toggle
/**
 * NodeView tests for sql_block: auto-run on mount renders a results table,
 * leak discipline on 403, SQL error display, XSS (text nodes only), the
 * hidden/collapsed state, and the Show/Hide toggle dispatching a setNodeMarkup.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import { SqlBlockView } from "../sqlBlockView";

type QueryInit = { ok?: boolean; status?: number };

/**
 * Stub fetch so `/.json` returns a db list and `/{db}/-/query.json` returns
 * the supplied query response.
 */
function stubFetch(query: unknown, init: QueryInit = {}) {
  const { ok = true, status = 200 } = init;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/.json")) {
        return { ok: true, status: 200, json: async () => ({ databases: [{ name: "data" }] }) };
      }
      return { ok, status, json: async () => query };
    }),
  );
}

function makeNode(sql: string, attrs: { db?: string; hidden?: boolean } = {}) {
  return schema.nodes.sql_block.create(
    { db: attrs.db ?? "data", hidden: attrs.hidden ?? false },
    sql ? [schema.text(sql)] : [],
  );
}

/** A view stub that records dispatched transactions. */
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
  sql: string,
  query: unknown,
  init: QueryInit = {},
  attrs: { db?: string; hidden?: boolean } = {},
) {
  stubFetch(query, init);
  const dispatched: unknown[] = [];
  const node = makeNode(sql, attrs);
  const view = new SqlBlockView(node, fakeView(dispatched), () => 0);
  await new Promise((r) => setTimeout(r, 0));
  return { view, dispatched };
}

describe("SqlBlockView", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("auto-runs on mount and renders a results table with column headers", async () => {
    const { view } = await build("select region, n", {
      ok: true,
      columns: ["region", "n"],
      rows: [["North", 1]],
    });
    const table = view.dom.querySelector("table");
    expect(table).not.toBeNull();
    expect([...view.dom.querySelectorAll("thead th")].map((t) => t.textContent)).toEqual([
      "region",
      "n",
    ]);
    expect(view.dom.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(view.dom.textContent).toContain("of 1 row");
  });

  // @feat result-cells: SQL result cells collapse long/multi-line/blob values
  it("collapses long cells and shows blob size, expandable in place", async () => {
    const { view } = await build("select * from ugly", {
      ok: true,
      columns: ["multi", "blob"],
      rows: [["a\nb", { $base64: true, encoded: "aGVsbG8=" }]],
    });
    const tds = [...view.dom.querySelectorAll("td")];
    expect(tds[0].querySelector(".pm-result-cell")!.textContent).toBe("a…");
    expect(tds[1].textContent).toBe("<binary — 5 B>");
    expect(view.dom.textContent).not.toContain("aGVsbG8"); // payload stays out
    tds[0].querySelector<HTMLButtonElement>(".pm-result-cell-expand")!.click();
    expect(tds[0].querySelector(".pm-result-cell")!.textContent).toBe("a\nb");
  });

  it("right-aligns an 'open in Datasette' link to the query page", async () => {
    const { view } = await build("select 1 as n", { ok: true, columns: ["n"], rows: [[1]] });
    const link = view.dom.querySelector(".pm-sql-block-footer-link") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toContain("open in Datasette");
    expect(link.getAttribute("href")).toBe("/data/-/query?sql=select%201%20as%20n");
  });

  it("shows the first page and paginates 25/100-configurable", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => [i + 1]);
    const { view } = await build("select id from t", { ok: true, columns: ["id"], rows });
    // Default page size 10 → first 10 rows, range label, pager present.
    expect(view.dom.querySelectorAll("tbody tr")).toHaveLength(10);
    expect(view.dom.textContent).toContain("1–10 of 40");
    const pager = view.dom.querySelector(".pm-sql-block-pager");
    expect(pager).not.toBeNull();
    expect(view.dom.querySelector(".pm-sql-block-page-label")!.textContent).toBe("1 / 4");
    // Next page → rows 11–20.
    const [prev, next] = view.dom.querySelectorAll<HTMLButtonElement>(".pm-sql-block-page-btn");
    expect(prev.disabled).toBe(true);
    next.click();
    expect(view.dom.textContent).toContain("11–20 of 40");
    expect(view.dom.querySelector(".pm-sql-block-page-label")!.textContent).toBe("2 / 4");
    // Change page size to 100 → all 40 on one page, pager gone.
    const select = view.dom.querySelector(".pm-sql-block-rows") as HTMLSelectElement;
    select.value = "100";
    select.dispatchEvent(new Event("change"));
    expect(view.dom.querySelectorAll("tbody tr")).toHaveLength(40);
    expect(view.dom.querySelector(".pm-sql-block-pager")).toBeNull();
    expect(view.dom.textContent).toContain("1–40 of 40");
  });

  it("exposes the SQL as an editable contentDOM", async () => {
    const { view } = await build("select 1", { ok: true, columns: [], rows: [] });
    expect(view.contentDOM).not.toBeNull();
    expect(view.contentDOM.tagName).toBe("CODE");
  });

  it("shows a no-rows status when the query returns nothing", async () => {
    const { view } = await build("select 1 where 0", { ok: true, columns: ["n"], rows: [] });
    expect(view.dom.textContent).toContain("No rows");
    expect(view.dom.querySelector("table")).toBeNull();
  });

  it("maps 403 to a generic placeholder and leaks no data", async () => {
    const { view } = await build("select secret", { rows: [["topsecret"]] }, { ok: false, status: 403 });
    expect(view.dom.textContent).toContain("permission");
    expect(view.dom.textContent).not.toContain("topsecret");
    expect(view.dom.querySelector("table")).toBeNull();
  });

  it("shows a SQL error message", async () => {
    const { view } = await build(
      "select * from nope",
      { ok: false, error: "no such table: nope" },
      { ok: false, status: 400 },
    );
    expect(view.dom.textContent).toContain("no such table: nope");
  });

  it("renders cell values as text (XSS-safe)", async () => {
    const { view } = await build("select x", {
      ok: true,
      columns: ["x"],
      rows: [['<img src=x onerror="alert(1)">']],
    });
    expect(view.dom.querySelector("img")).toBeNull();
    expect(view.dom.querySelector("td")!.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it("warns when the result was truncated by Datasette's row cap", async () => {
    const { view } = await build("select * from big", {
      ok: true,
      columns: ["id"],
      rows: [[1]],
      truncated: true,
    });
    const warn = view.dom.querySelector(".pm-sql-block-warn");
    expect(warn).not.toBeNull();
    expect(warn!.textContent).toContain("truncated");
  });

  it("copies results as CSV via the export menu", async () => {
    const writeText = vi.fn(async (_t: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { view } = await build("select id, name from t", {
      ok: true,
      columns: ["id", "name"],
      rows: [[1, "Acme"]],
    });
    view.dom.querySelector<HTMLButtonElement>(".pm-sql-block-menu-btn")!.click();
    const items = view.dom.querySelectorAll<HTMLButtonElement>(".pm-sql-block-menu-item");
    items[0].click(); // Copy as CSV
    expect(writeText).toHaveBeenCalledWith("id,name\n1,Acme");
  });

  it("copies results as JSON via the export menu", async () => {
    const writeText = vi.fn(async (_t: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { view } = await build("select id from t", {
      ok: true,
      columns: ["id"],
      rows: [[1]],
    });
    view.dom.querySelector<HTMLButtonElement>(".pm-sql-block-menu-btn")!.click();
    const items = view.dom.querySelectorAll<HTMLButtonElement>(".pm-sql-block-menu-item");
    items[1].click(); // Copy as JSON
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual([{ id: 1 }]);
  });

  it("mutes the Run button in sync and lights it up when the SQL is edited", async () => {
    const { view } = await build("select 1", { ok: true, columns: ["n"], rows: [[1]] });
    const run = () => view.dom.querySelector(".pm-sql-block-run")!;
    // After the auto-run, the results reflect the current SQL → not stale.
    expect(run().classList.contains("pm-sql-block-run--stale")).toBe(false);
    // Editing the SQL (a content update) marks the results stale.
    const edited = schema.nodes.sql_block.create({ db: "data", hidden: false }, [
      schema.text("select 2"),
    ]);
    view.update(edited);
    expect(run().classList.contains("pm-sql-block-run--stale")).toBe(true);
  });

  it("collapses the SQL editor when hidden but keeps results visible", async () => {
    const { view } = await build(
      "select 1 as n",
      { ok: true, columns: ["n"], rows: [[1]] },
      {},
      { hidden: true },
    );
    expect(view.dom.classList.contains("is-hidden")).toBe(true);
    expect(view.dom.querySelector("table")).not.toBeNull();
    expect(view.dom.querySelector(".pm-sql-block-toggle")!.textContent).toContain("Show SQL");
  });

  it("toggle button dispatches a hidden attr change", async () => {
    const { view, dispatched } = await build("select 1", { ok: true, columns: [], rows: [] });
    const toggle = view.dom.querySelector(".pm-sql-block-toggle") as HTMLButtonElement;
    toggle.click();
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0] as { attrs: { hidden: boolean } }).attrs.hidden).toBe(true);
  });

  it("discards a stale in-flight result after destroy", async () => {
    stubFetch({ ok: true, columns: ["n"], rows: [[1]] });
    const node = makeNode("select 1");
    const view = new SqlBlockView(node, fakeView([]), () => 0);
    view.destroy(); // bumps token before the fetch resolves
    await new Promise((r) => setTimeout(r, 0));
    expect(view.dom.querySelector("table")).toBeNull();
  });
});
