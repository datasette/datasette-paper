// @feat block-embed: tests block render modes built from native Datasette JSON
/**
 * NodeView tests for block_embed: renders table / row / database / denied /
 * not_found, building each from a NATIVE Datasette `.json` response, with all
 * data going into the DOM as text (XSS rule).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorView } from "prosemirror-view";
import { EditorState } from "prosemirror-state";

import { schema } from "../schema";
import { BlockEmbedView } from "../blockEmbedView";
import { embedRegistry, _resetEmbedRegistryForTest } from "../embedRegistry";

type NativeInit = { ok?: boolean; status?: number };

function stubFetch(native: unknown, init: NativeInit = {}) {
  const { ok = true, status = 200 } = init;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status, json: async () => native })),
  );
}

async function build(
  ref: string,
  native: unknown,
  init: NativeInit = {},
): Promise<BlockEmbedView> {
  stubFetch(native, init);
  const node = schema.nodes.block_embed.create({ ref });
  const view = new BlockEmbedView(node, { editable: true, dom: document.createElement("div") } as unknown as EditorView, () => 0);
  // Let the async load() resolve.
  await new Promise((r) => setTimeout(r, 0));
  return view;
}

// The rendered column labels: each th's LEADING text node. For an editor the
// th also hosts the ▾ column menu, whose (CSS-hidden) item labels would leak
// into a plain textContent read.
function thLabels(root: { querySelectorAll: ParentNode["querySelectorAll"] }): (string | null)[] {
  return [...root.querySelectorAll("th")].map((t) => t.childNodes[0].textContent);
}

describe("BlockEmbedView", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders a table payload into a <table> with header + rows", async () => {
    const view = await build("/data/vendors", {
      columns: ["id", "name"],
      rows: [
        [1, "Acme"],
        [2, "Globex"],
      ],
      count: 30,
      next: "cursor",
    });
    const table = view.dom.querySelector("table");
    expect(table).not.toBeNull();
    expect(thLabels(view.dom)).toEqual(["id", "name"]);
    expect(view.dom.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(view.dom.textContent).toContain("Acme");
    // Footer: inline limit dropdown + total count ("showing [10] of 30 rows").
    expect(view.dom.textContent).toContain("of 30 rows");
    expect(
      (view.dom.querySelector(".pm-block-embed-rows") as HTMLSelectElement).value,
    ).toBe("10");
    expect(view.dom.querySelector(".pm-block-embed-label")!.textContent).toBe(
      "data/vendors",
    );
  });

  it("makes the header label a link to the resource page", async () => {
    const view = await build("/data/vendors", {
      columns: ["id"],
      rows: [[1]],
      count: 1,
    });
    const label = view.dom.querySelector(".pm-block-embed-label");
    expect(label?.tagName).toBe("A");
    expect(label?.getAttribute("href")).toBe("/data/vendors");
  });

  it("defaults to 10 rows and offers 10/25/100 in the footer dropdown", async () => {
    const view = await build("/data/vendors", { columns: ["id"], rows: [[1]], count: 1 });
    const select = view.dom.querySelector(
      ".pm-block-embed-rows",
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect([...select!.options].map((o) => o.value)).toEqual(["10", "25", "100"]);
    expect(select!.value).toBe("10");
  });

  it("fetches with the default limit, then re-fetches when the dropdown changes", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ columns: ["id"], rows: [[1]], count: 1 }) };
      }),
    );
    const node = schema.nodes.block_embed.create({ ref: "/data/vendors" });
    const view = new BlockEmbedView(node, { editable: true, dom: document.createElement("div") } as unknown as EditorView, () => 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(urls[0]).toContain("_size=10");

    const select = view.dom.querySelector(
      ".pm-block-embed-rows",
    ) as HTMLSelectElement;
    select.value = "100";
    select.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(urls.at(-1)).toContain("_size=100");
  });

  it("renders an 'open in Datasette' footer link to the resource", async () => {
    const view = await build("/data/vendors", { columns: ["id"], rows: [[1]], count: 1 });
    const link = view.dom.querySelector(
      ".pm-block-embed-footer-link",
    ) as HTMLAnchorElement | null;
    expect(link?.getAttribute("href")).toBe("/data/vendors");
    expect(link?.textContent).toContain("open in Datasette");
  });

  it("renders a row payload into a fields card titled db/table/pk", async () => {
    const view = await build("/data/vendors/1", {
      columns: ["id", "name"],
      rows: [{ id: 1, name: "Acme" }],
    });
    // Title is the path identity, not the human label.
    expect(view.dom.querySelector(".pm-block-embed-label")!.textContent).toBe(
      "data/vendors/1",
    );
    const dts = [...view.dom.querySelectorAll("dt")].map((d) => d.textContent);
    const dds = [...view.dom.querySelectorAll("dd")].map((d) => d.textContent);
    expect(dts).toEqual(["id", "name"]);
    expect(dds).toEqual(["1", "Acme"]);
  });

  it("renders a denied placeholder with no data", async () => {
    const view = await build("/data/secret", {}, { ok: false, status: 403 });
    expect(view.dom.classList.contains("pm-block-embed--denied")).toBe(true);
    expect(view.dom.querySelector("table")).toBeNull();
    expect(view.dom.textContent).toContain("don't have access");
    // The label "secret" must not appear.
    expect(view.dom.textContent).not.toContain("secret");
  });

  it("renders a not_found placeholder", async () => {
    const view = await build("/data/nope", {}, { ok: false, status: 404 });
    expect(view.dom.classList.contains("pm-block-embed--missing")).toBe(true);
    expect(view.dom.textContent).toContain("not found");
  });

  it("renders a database payload as a table listing", async () => {
    const view = await build("/data", {
      tables: [{ name: "vendors", count: 30 }],
      views: [{ name: "vendor_names" }],
    });
    const links = [...view.dom.querySelectorAll(".pm-block-embed-table-link")];
    expect(links.map((l) => l.textContent)).toEqual(["vendors", "vendor_names"]);
    expect((links[0] as HTMLAnchorElement).getAttribute("href")).toBe("/data/vendors");
    expect(view.dom.textContent).toContain("30 rows");
    expect(view.dom.textContent).toContain("2 tables");
    expect(
      (view.dom.querySelector(".pm-block-embed-label") as HTMLAnchorElement).getAttribute(
        "href",
      ),
    ).toBe("/data");
  });

  it("overflow menu converts the block embed into an inline ref", async () => {
    stubFetch({ columns: ["id"], rows: [[1]], count: 1 });
    const embed = schema.nodes.block_embed.create({ ref: "/data/vendors" });
    const doc = schema.node("doc", null, [embed]);
    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({ doc }),
      nodeViews: {
        block_embed: (node, v, getPos) =>
          new BlockEmbedView(node, v, getPos as () => number | undefined),
      },
    });
    // Let the NodeView's load() resolve and render the header (with the menu).
    await new Promise((r) => setTimeout(r, 0));

    const btn = view.dom.querySelector(
      ".pm-block-embed-menu-btn",
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    const menu = view.dom.querySelector(".pm-block-embed-menu") as HTMLElement;
    const isOpen = () => menu.classList.contains("pm-block-embed-menu--open");
    expect(isOpen()).toBe(false);
    btn.click();
    expect(isOpen()).toBe(true);
    // Clicking elsewhere closes it.
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(isOpen()).toBe(false);
    // Reopen and convert.
    btn.click();
    expect(isOpen()).toBe(true);

    // The menu now leads with export items; pick the Convert item by label.
    const convert = [...view.dom.querySelectorAll(".pm-block-embed-menu-item")].find(
      (el) => el.textContent === "Convert to inline element",
    ) as HTMLButtonElement;
    convert.click();

    const para = view.state.doc.firstChild!;
    expect(para.type.name).toBe("paragraph");
    expect(para.firstChild?.type.name).toBe("inline_embed");
    expect(para.firstChild?.attrs.ref).toBe("/data/vendors");

    view.destroy();
    place.remove();
  });

  it("delegates a provider-claimed ref to its mount, with a header from resolve", async () => {
    const mount = vi.fn((host: HTMLElement) => {
      host.textContent = "custom body";
    });
    embedRegistry().register({
      kind: "place-list",
      matchRef: (ref) => ref.startsWith("/-/places/list/"),
      resolve: async (ref) => ({
        status: "ok",
        kind: "place-list",
        label: "My places",
        href: ref,
        icon: '<svg data-prov="1"><path d="M0 0h1v1H0z"/></svg>',
      }),
      mount,
    });
    try {
      // No fetch should happen for a provider-claimed ref.
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const node = schema.nodes.block_embed.create({ ref: "/-/places/list/5" });
      const view = new BlockEmbedView(node, { editable: true, dom: document.createElement("div") } as unknown as EditorView, () => 0);
      await new Promise((r) => setTimeout(r, 0));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(view.dom.querySelector(".pm-block-embed-label")!.textContent).toBe(
        "My places",
      );
      // The provider's raw icon svg is rendered into the header icon slot.
      expect(
        view.dom.querySelector(".pm-block-embed-icon svg[data-prov]"),
      ).not.toBeNull();
      const host = view.dom.querySelector(".pm-block-embed-external");
      expect(host).not.toBeNull();
      expect(host!.textContent).toBe("custom body");
      expect(mount).toHaveBeenCalledTimes(1);
    } finally {
      _resetEmbedRegistryForTest();
    }
  });

  it("passes the node's config attr into the provider mount ctx", async () => {
    const ctxSeen: { config?: unknown; mode?: string } = {};
    embedRegistry().register({
      kind: "place-list",
      matchRef: (ref) => ref.startsWith("/-/places/list/"),
      resolve: async (ref) => ({
        status: "ok",
        kind: "place-list",
        label: "My places",
        href: ref,
      }),
      mount: (host, ctx) => {
        ctxSeen.config = ctx.config;
        ctxSeen.mode = ctx.mode;
        host.textContent = "ok";
      },
    });
    try {
      const config = { columns: ["name", "id"], sort: "-created" };
      const node = schema.nodes.block_embed.create({
        ref: "/-/places/list/5",
        config,
      });
      new BlockEmbedView(node, { editable: true, dom: document.createElement("div") } as unknown as EditorView, () => 0);
      await new Promise((r) => setTimeout(r, 0));
      expect(ctxSeen.config).toEqual(config);
    } finally {
      _resetEmbedRegistryForTest();
    }
  });

  it("survives a config attr through a DOM toDOM/parseDOM round-trip", () => {
    const config = { columns: ["a"], nested: { x: 1 } };
    const node = schema.nodes.block_embed.create({ ref: "/data/t", config });
    // toDOM stringifies config into data-embed-config.
    const out = node.type.spec.toDOM!(node) as [string, Record<string, string>];
    expect(JSON.parse(out[1]["data-embed-config"])).toEqual(config);
    // parseDOM getAttrs reads it back.
    const div = document.createElement("div");
    div.setAttribute("data-block-embed", "/data/t");
    div.setAttribute("data-embed-config", out[1]["data-embed-config"]);
    const getAttrs = node.type.spec.parseDOM![0].getAttrs as (
      el: HTMLElement,
    ) => Record<string, unknown>;
    expect(getAttrs(div).config).toEqual(config);
    // A malformed blob degrades to {}.
    div.setAttribute("data-embed-config", "{not json");
    expect(getAttrs(div).config).toEqual({});
  });

  it("renders a leak-free denied placeholder when a provider resolves denied", async () => {
    embedRegistry().register({
      kind: "place-list",
      matchRef: (ref) => ref.startsWith("/-/places/"),
      resolve: async () => ({ status: "denied" }),
      mount: () => {
        throw new Error("must not mount on denied");
      },
    });
    try {
      const node = schema.nodes.block_embed.create({ ref: "/-/places/list/secret" });
      const view = new BlockEmbedView(node, { editable: true, dom: document.createElement("div") } as unknown as EditorView, () => 0);
      await new Promise((r) => setTimeout(r, 0));
      expect(view.dom.classList.contains("pm-block-embed--denied")).toBe(true);
      expect(view.dom.textContent).not.toContain("secret");
      expect(view.dom.querySelector(".pm-block-embed-external")).toBeNull();
    } finally {
      _resetEmbedRegistryForTest();
    }
  });

  it("escapes html in cell values (text node only)", async () => {
    const view = await build("/data/x", {
      columns: ["c"],
      rows: [["<img src=x onerror=alert(1)>"]],
      count: 1,
    });
    // The payload string is present as text, but no <img> element was created.
    expect(view.dom.querySelector("td img")).toBeNull();
    expect(view.dom.querySelector("td")!.textContent).toContain("<img");
  });

  // ── Ticket 02: footer layout (link left, count right) ─────────────────────

  it("orders the table footer: open-in-Datasette link first, info second", async () => {
    const view = await build("/data/vendors", {
      columns: ["id"],
      rows: [[1]],
      count: 30,
    });
    const footer = view.dom.querySelector(".pm-block-embed-footer")!;
    const kids = [...footer.children];
    expect(kids[0].classList.contains("pm-block-embed-footer-link")).toBe(true);
    expect(kids[1].classList.contains("pm-block-embed-footer-info")).toBe(true);
    expect(kids[1].textContent).toContain("of 30 rows");
  });

  it("orders the database footer the same way (link first, count second)", async () => {
    const view = await build("/data", {
      tables: [{ name: "vendors", count: 30 }],
    });
    const footer = view.dom.querySelector(".pm-block-embed-footer")!;
    const kids = [...footer.children];
    expect(kids[0].classList.contains("pm-block-embed-footer-link")).toBe(true);
    expect(kids[1].classList.contains("pm-block-embed-footer-info")).toBe(true);
  });

  // ── Ticket 01: export menu ────────────────────────────────────────────────

  function exportItems(view: BlockEmbedView): HTMLElement[] {
    return [...view.dom.querySelectorAll(".pm-block-embed-menu .pm-block-embed-menu-item")] as HTMLElement[];
  }

  it("adds CSV/JSON download links + a Copy page item to the ⋮ menu for a table", async () => {
    const view = await build("/data/vendors", {
      columns: ["id", "name"],
      rows: [[1, "Acme"]],
      count: 30,
    });
    const items = exportItems(view);
    const labels = items.map((i) => i.textContent);
    expect(labels.some((l) => l!.startsWith("Download CSV"))).toBe(true);
    expect(labels.some((l) => l!.startsWith("Download JSON"))).toBe(true);
    // Copy is honestly labelled as the page when count > held rows.
    expect(labels.some((l) => l!.includes("Copy as CSV (page, 1 of 30)"))).toBe(true);
    expect(labels.some((l) => l!.includes("Copy as JSON (page, 1 of 30)"))).toBe(true);
    // "Convert to inline element" is still present.
    expect(labels).toContain("Convert to inline element");
  });

  it("download links point at Datasette's native streaming endpoints", async () => {
    const view = await build("/data/vendors", {
      columns: ["id"],
      rows: [[1]],
      count: 30,
    });
    const links = exportItems(view).filter(
      (i) => i.tagName === "A",
    ) as HTMLAnchorElement[];
    const csv = links.find((a) => a.textContent!.startsWith("Download CSV"))!;
    const json = links.find((a) => a.textContent!.startsWith("Download JSON"))!;
    expect(csv.getAttribute("href")).toBe("/data/vendors.csv?_stream=on");
    expect(json.getAttribute("href")).toBe("/data/vendors.json?_shape=array");
  });

  it("labels Copy as the full set (row count, no 'page') when all rows are held", async () => {
    const view = await build("/data/vendors", {
      columns: ["id"],
      rows: [[1], [2]],
      count: 2,
    });
    const labels = exportItems(view).map((i) => i.textContent);
    expect(labels.some((l) => l === "Copy as CSV (2 rows)")).toBe(true);
    expect(labels.some((l) => l!.includes("page"))).toBe(false);
  });

  it("Copy page writes the held rows (serialized) to the clipboard", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = await build("/data/vendors", {
      columns: ["id", "name"],
      rows: [[1, "Acme"]],
      count: 30,
    });
    const copyCsv = exportItems(view).find((i) =>
      i.textContent!.startsWith("Copy as CSV"),
    ) as HTMLButtonElement;
    copyCsv.click();
    expect(writeText).toHaveBeenCalledWith("id,name\n1,Acme");
  });

  it("offers no export items for a non-table embed (row card)", async () => {
    const view = await build("/data/vendors/1", {
      columns: ["id", "name"],
      rows: [{ id: 1, name: "Acme" }],
    });
    const labels = exportItems(view).map((i) => i.textContent);
    expect(labels).toEqual(["Convert to inline element"]);
  });

  // ── Column filter: fetch projection + the "Columns…" picker ───────────────

  // Mount a block_embed (optionally with attrs) into a real EditorView, so the
  // picker's setNodeMarkup transaction has a live state/dispatch to write to.
  // `editable` is the live EditorView prop the NodeView gates its config UI on.
  async function mountEmbed(
    attrs: Record<string, unknown>,
    native: unknown,
    editable?: () => boolean,
  ): Promise<{ view: EditorView; nodeView: BlockEmbedView }> {
    stubFetch(native);
    let captured: BlockEmbedView | null = null;
    const embed = schema.nodes.block_embed.create(attrs);
    const doc = schema.node("doc", null, [embed]);
    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({ doc }),
      ...(editable ? { editable } : {}),
      nodeViews: {
        block_embed: (node, v, getPos) => {
          captured = new BlockEmbedView(node, v, getPos as () => number | undefined);
          return captured;
        },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    return { view, nodeView: captured! };
  }

  function openColumnsPanel(view: EditorView): HTMLInputElement[] {
    (view.dom.querySelector(".pm-block-embed-menu-btn") as HTMLButtonElement).click();
    const colsBtn = [...view.dom.querySelectorAll(".pm-block-embed-menu-item")].find(
      (el) => el.textContent === "Columns…",
    ) as HTMLButtonElement;
    colsBtn.click();
    return [...view.dom.querySelectorAll(".pm-block-embed-columns-item input")] as HTMLInputElement[];
  }

  it("issues _col= for config.columns and renders only the projected columns", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        // PK `id` forced back in by the server even though only name/region picked.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            columns: ["id", "name", "region"],
            rows: [[1, "Acme", "West"]],
            count: 1,
          }),
        };
      }),
    );
    const node = schema.nodes.block_embed.create({
      ref: "/data/vendors",
      config: { columns: ["name", "region"] },
    });
    const view = new BlockEmbedView(node, { editable: true, dom: document.createElement("div") } as unknown as EditorView, () => 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(urls[0]).toContain("_col=name");
    expect(urls[0]).toContain("_col=region");
    // Only the picked columns reach the rendered header — the PK is dropped.
    expect(thLabels(view.dom)).toEqual(["name", "region"]);
  });

  it("the ⋮ menu lists every column as a checkbox, selected ones checked", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors", config: { columns: ["name"] } },
      { columns: ["id", "name", "region"], rows: [[1, "Acme", "West"]], count: 1 },
    );
    const boxes = openColumnsPanel(view);
    expect(boxes.map((b) => (b.nextSibling as HTMLElement).textContent)).toEqual([
      "id",
      "name",
      "region",
    ]);
    // Only the selected "name" is checked.
    expect(boxes.map((b) => b.checked)).toEqual([false, true, false]);
    view.destroy();
  });

  it("checks all columns when config.columns is empty (show-all)", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors" },
      { columns: ["id", "name"], rows: [[1, "Acme"]], count: 1 },
    );
    const boxes = openColumnsPanel(view);
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
    view.destroy();
  });

  it("Apply writes the ordered selection to config.columns", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors" },
      { columns: ["id", "name", "region"], rows: [[1, "Acme", "West"]], count: 1 },
    );
    const boxes = openColumnsPanel(view);
    // Uncheck the PK "id", keep name + region.
    boxes[0].checked = false;
    (view.dom.querySelector(".pm-block-embed-columns-apply") as HTMLButtonElement).click();
    expect(view.state.doc.firstChild!.attrs.config).toEqual({
      columns: ["name", "region"],
    });
    view.destroy();
  });

  it("Apply with every column checked stores [] (minimal show-all config)", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors", config: { columns: ["name"] } },
      { columns: ["id", "name"], rows: [[1, "Acme"]], count: 1 },
    );
    const boxes = openColumnsPanel(view);
    boxes.forEach((b) => (b.checked = true));
    (view.dom.querySelector(".pm-block-embed-columns-apply") as HTMLButtonElement).click();
    expect(view.state.doc.firstChild!.attrs.config).toEqual({ columns: [] });
    view.destroy();
  });

  // ── Table filters T01: config.filters/sort → fetch params + title link ────

  function stubUrlCapture(native: unknown): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => native };
      }),
    );
    return urls;
  }

  const FILTERED_CONFIG = {
    columns: ["name"],
    filters: [
      { column: "state", op: "exact", value: "CA" },
      { column: "notes", op: "notblank" },
    ],
    sort: { column: "population", desc: true },
  };

  it("fetches with column__op / _sort_desc params when config has filters", async () => {
    const urls = stubUrlCapture({
      columns: ["id", "name"],
      rows: [[1, "Acme"]],
      count: 1,
    });
    const node = schema.nodes.block_embed.create({
      ref: "/data/vendors",
      config: FILTERED_CONFIG,
    });
    new BlockEmbedView(node, { editable: true, dom: document.createElement("div") } as unknown as EditorView, () => 0);
    await new Promise((r) => setTimeout(r, 0));
    const query = new URLSearchParams(urls[0].split("?")[1]);
    expect(query.get("state__exact")).toBe("CA");
    expect(query.get("notes__notblank")).toBe("1");
    expect(query.get("_sort_desc")).toBe("population");
    expect(query.get("_sort")).toBeNull();
  });

  it("carries filters/sort/_col on the title link, but no fetch-only params", async () => {
    stubFetch({ columns: ["id", "name"], rows: [[1, "Acme"]], count: 1 });
    const node = schema.nodes.block_embed.create({
      ref: "/data/vendors",
      config: FILTERED_CONFIG,
    });
    const view = new BlockEmbedView(node, { editable: true, dom: document.createElement("div") } as unknown as EditorView, () => 0);
    await new Promise((r) => setTimeout(r, 0));
    const href = (
      view.dom.querySelector(".pm-block-embed-label") as HTMLAnchorElement
    ).getAttribute("href")!;
    expect(href.startsWith("/data/vendors?")).toBe(true);
    const query = new URLSearchParams(href.split("?")[1]);
    expect(query.get("state__exact")).toBe("CA");
    expect(query.get("notes__notblank")).toBe("1");
    expect(query.get("_sort_desc")).toBe("population");
    expect(query.getAll("_col")).toEqual(["name"]);
    // Fetch-only params never ride the link — the page picks its own.
    expect(query.get("_shape")).toBeNull();
    expect(query.get("_extra")).toBeNull();
    expect(query.get("_size")).toBeNull();
  });

  it("keeps the title link clean (bare path) when config has no filters", async () => {
    const view = await build("/data/vendors", {
      columns: ["id"],
      rows: [[1]],
      count: 1,
    });
    expect(
      view.dom.querySelector(".pm-block-embed-label")!.getAttribute("href"),
    ).toBe("/data/vendors");
  });

  it("a crafted filter value stays one encoded param on the title link", async () => {
    stubFetch({ columns: ["id"], rows: [[1]], count: 1 });
    const node = schema.nodes.block_embed.create({
      ref: "/data/vendors",
      config: { filters: [{ column: "state", op: "exact", value: "CA&_del=1" }] },
    });
    const view = new BlockEmbedView(node, { editable: true, dom: document.createElement("div") } as unknown as EditorView, () => 0);
    await new Promise((r) => setTimeout(r, 0));
    const href = (
      view.dom.querySelector(".pm-block-embed-label") as HTMLAnchorElement
    ).getAttribute("href")!;
    expect(href).toContain("state__exact=CA%26_del%3D1");
    const query = new URLSearchParams(href.split("?")[1]);
    expect(query.get("state__exact")).toBe("CA&_del=1");
    expect(query.get("_del")).toBeNull();
  });

  it("a config-only setNodeMarkup re-fetches with the new filter params", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors" },
      { columns: ["id"], rows: [[1]], count: 1 },
    );
    // Swap in a URL-capturing stub for the re-fetch the config write triggers.
    const captured = stubUrlCapture({ columns: ["id"], rows: [[1]], count: 1 });
    const node = view.state.doc.firstChild!;
    view.dispatch(
      view.state.tr.setNodeMarkup(0, undefined, {
        ...node.attrs,
        config: { filters: [{ column: "state", op: "exact", value: "CA" }] },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.at(-1)).toContain("state__exact=CA");
    view.destroy();
  });

  it("drops malformed filter entries from the fetch instead of 400ing the embed", async () => {
    const urls = stubUrlCapture({ columns: ["id"], rows: [[1]], count: 1 });
    const node = schema.nodes.block_embed.create({
      ref: "/data/vendors",
      config: {
        filters: [
          { column: "state", op: "regex", value: "x" }, // unknown op → dropped
          { column: "state", op: "exact", value: "CA" },
        ],
        sort: { desc: true }, // no column → ignored
      },
    });
    new BlockEmbedView(node, { editable: true, dom: document.createElement("div") } as unknown as EditorView, () => 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(urls[0]).toContain("state__exact=CA");
    expect(urls[0]).not.toContain("regex");
    expect(urls[0]).not.toContain("_sort");
  });

  it("surfaces the server's error text on a non-200 with an error body", async () => {
    const view = await build(
      "/data/vendors",
      { ok: false, error: "Cannot sort table by nope" },
      { ok: false, status: 400 },
    );
    expect(view.dom.classList.contains("pm-block-embed--error")).toBe(true);
    // The message lands as text (no table, no markup injection).
    expect(view.dom.querySelector("table")).toBeNull();
    expect(
      view.dom.querySelector(".pm-block-embed-placeholder")!.textContent,
    ).toBe("Cannot sort table by nope");
  });

  // ── Table filters T02: config-writing UI is gated on view.editable ────────

  function menuLabels(view: EditorView): (string | null)[] {
    return [...view.dom.querySelectorAll(".pm-block-embed-menu-item")].map(
      (el) => el.textContent,
    );
  }

  it("hides the ⋮ config items (Columns…, Convert) from read-only viewers", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors" },
      { columns: ["id", "name"], rows: [[1, "Acme"]], count: 1 },
      () => false,
    );
    const labels = menuLabels(view);
    // Export/copy items stay — they dispatch nothing.
    expect(labels.some((l) => l!.startsWith("Download CSV"))).toBe(true);
    expect(labels.some((l) => l!.startsWith("Copy as CSV"))).toBe(true);
    expect(labels).not.toContain("Columns…");
    expect(labels).not.toContain("Convert to inline element");
    // Refresh stays available to everyone (read-only re-fetch, no step).
    expect(view.dom.querySelector(".pm-block-embed-refresh")).not.toBeNull();
    view.destroy();
  });

  it("renders no ⋮ button at all for a read-only non-table embed (empty menu)", async () => {
    const { view } = await mountEmbed(
      { ref: "/data" },
      { tables: [{ name: "vendors", count: 3 }] },
      () => false,
    );
    expect(view.dom.querySelector(".pm-block-embed-menu-btn")).toBeNull();
    expect(view.dom.querySelector(".pm-block-embed-refresh")).not.toBeNull();
    view.destroy();
  });

  it("config-writing handlers no-op when not editable (belt and braces)", async () => {
    const { view, nodeView } = await mountEmbed(
      { ref: "/data/vendors" },
      { columns: ["id", "name"], rows: [[1, "Acme"]], count: 1 },
      () => false,
    );
    const before = view.state.doc;
    const internals = nodeView as unknown as {
      setColumns: (columns: string[]) => void;
      convertToInline: () => void;
    };
    internals.setColumns(["name"]);
    internals.convertToInline();
    expect(view.state.doc.eq(before)).toBe(true);
    view.destroy();
  });

  it("update() re-gates the chrome when editability flips mid-session", async () => {
    let editable = true;
    const { view, nodeView } = await mountEmbed(
      { ref: "/data/vendors" },
      { columns: ["id", "name"], rows: [[1, "Acme"]], count: 1 },
      () => editable,
    );
    expect(menuLabels(view)).toContain("Columns…");

    // Flip to read-only (view/edit toggle, stepError) and re-check on update().
    editable = false;
    view.setProps({ editable: () => editable });
    nodeView.update(view.state.doc.firstChild!);
    expect(menuLabels(view)).not.toContain("Columns…");
    expect(menuLabels(view)).not.toContain("Convert to inline element");

    // And back: the controls reappear without a re-fetch.
    editable = true;
    view.setProps({ editable: () => editable });
    nodeView.update(view.state.doc.firstChild!);
    expect(menuLabels(view)).toContain("Columns…");
    view.destroy();
  });

  it("closes an open columns panel when editability flips to false", async () => {
    let editable = true;
    const { view, nodeView } = await mountEmbed(
      { ref: "/data/vendors" },
      { columns: ["id", "name"], rows: [[1, "Acme"]], count: 1 },
      () => editable,
    );
    openColumnsPanel(view);
    expect(view.dom.querySelector(".pm-block-embed-columns")).not.toBeNull();
    expect(
      view.dom.querySelector(".pm-block-embed-menu--open"),
    ).not.toBeNull();

    editable = false;
    view.setProps({ editable: () => editable });
    nodeView.update(view.state.doc.firstChild!);
    expect(view.dom.querySelector(".pm-block-embed-columns")).toBeNull();
    expect(view.dom.querySelector(".pm-block-embed-menu--open")).toBeNull();
    view.destroy();
  });

  // ── Table filters T03: the "Filter & sort…" panel + header badge ──────────

  const NATIVE_3COL = {
    columns: ["id", "state", "population"],
    rows: [[1, "CA", 100]],
    count: 1,
  };

  function openFiltersPanel(view: EditorView) {
    (view.dom.querySelector(".pm-block-embed-menu-btn") as HTMLButtonElement).click();
    const item = [...view.dom.querySelectorAll(".pm-block-embed-menu-item")].find(
      (el) => el.textContent === "Filter & sort…",
    ) as HTMLButtonElement;
    item.click();
    return {
      panel: view.dom.querySelector(".pm-block-embed-filters") as HTMLElement,
      rows: () =>
        [...view.dom.querySelectorAll(".pm-block-embed-filter-row")] as HTMLElement[],
    };
  }

  function rowParts(row: HTMLElement) {
    return {
      column: row.querySelector(".pm-block-embed-filter-column") as HTMLSelectElement,
      op: row.querySelector(".pm-block-embed-filter-op") as HTMLSelectElement,
      value: row.querySelector(".pm-block-embed-filter-value") as HTMLInputElement,
    };
  }

  function sortControls(view: EditorView) {
    return {
      column: view.dom.querySelector(
        ".pm-block-embed-filter-sort-column",
      ) as HTMLSelectElement,
      dir: view.dom.querySelector(
        ".pm-block-embed-filter-sort-dir",
      ) as HTMLSelectElement,
    };
  }

  function applyBtn(view: EditorView): HTMLButtonElement {
    return view.dom.querySelector(".pm-block-embed-filter-apply") as HTMLButtonElement;
  }

  it("opens the panel with one row per configured filter plus a trailing blank", async () => {
    const { view } = await mountEmbed(
      {
        ref: "/data/vendors",
        config: {
          filters: [
            { column: "state", op: "exact", value: "CA" },
            { column: "population", op: "gt", value: "100" },
          ],
          sort: { column: "population", desc: true },
        },
      },
      NATIVE_3COL,
    );
    const { panel, rows } = openFiltersPanel(view);
    expect(panel).not.toBeNull();
    const all = rows();
    expect(all).toHaveLength(3);
    const first = rowParts(all[0]);
    expect(first.column.value).toBe("state");
    expect(first.op.value).toBe("exact");
    expect(first.value.value).toBe("CA");
    const second = rowParts(all[1]);
    expect(second.column.value).toBe("population");
    expect(second.op.value).toBe("gt");
    expect(second.value.value).toBe("100");
    // The trailing blank row starts on the empty "– column –" option.
    expect(rowParts(all[2]).column.value).toBe("");
    // The op select carries every registry op, in order.
    expect([...first.op.options].map((o) => o.value)).toHaveLength(22);
    // The sort row seeds from config.sort.
    const sort = sortControls(view);
    expect(sort.column.value).toBe("population");
    expect(sort.dir.value).toBe("desc");
    // The shared-view notice is always present in the panel.
    expect(
      view.dom.querySelector(".pm-block-embed-shared-notice")!.textContent,
    ).toContain("Shared view");
    view.destroy();
  });

  it("hides and disables the value input when a no-value op is chosen", async () => {
    const { view } = await mountEmbed({ ref: "/data/vendors" }, NATIVE_3COL);
    const { rows } = openFiltersPanel(view);
    const r = rowParts(rows()[0]);
    expect(r.value.disabled).toBe(false);
    expect(r.value.hidden).toBe(false);
    r.op.value = "notblank";
    r.op.dispatchEvent(new Event("change"));
    expect(r.value.disabled).toBe(true);
    expect(r.value.hidden).toBe(true);
    // And back — the visibility re-evaluates on every op change.
    r.op.value = "contains";
    r.op.dispatchEvent(new Event("change"));
    expect(r.value.disabled).toBe(false);
    expect(r.value.hidden).toBe(false);
    view.destroy();
  });

  it("grows a fresh blank row when the last row's column is chosen", async () => {
    const { view } = await mountEmbed({ ref: "/data/vendors" }, NATIVE_3COL);
    const { rows } = openFiltersPanel(view);
    expect(rows()).toHaveLength(1);
    const r = rowParts(rows()[0]);
    r.column.value = "state";
    r.column.dispatchEvent(new Event("change"));
    expect(rows()).toHaveLength(2);
    // Re-picking a column on a non-last row does not grow another.
    r.column.value = "population";
    r.column.dispatchEvent(new Event("change"));
    expect(rows()).toHaveLength(2);
    view.destroy();
  });

  it("Apply commits the form as exactly one transaction, dropping incomplete rows", async () => {
    const { view } = await mountEmbed({ ref: "/data/vendors" }, NATIVE_3COL);
    const dispatch = vi.spyOn(view, "dispatch");
    const { rows } = openFiltersPanel(view);
    const r = rowParts(rows()[0]);
    r.column.value = "state";
    r.column.dispatchEvent(new Event("change"));
    r.value.value = "CA"; // op stays on the first registry entry: exact
    // Second row: column + value-taking op but no value → incomplete, dropped.
    const r2 = rowParts(rows()[1]);
    r2.column.value = "population";
    r2.column.dispatchEvent(new Event("change"));
    r2.op.value = "gt";
    r2.op.dispatchEvent(new Event("change"));
    const sort = sortControls(view);
    sort.column.value = "population";
    sort.dir.value = "desc";
    applyBtn(view).click();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(view.state.doc.firstChild!.attrs.config).toEqual({
      filters: [{ column: "state", op: "exact", value: "CA" }],
      sort: { column: "population", desc: true },
    });
    view.destroy();
  });

  it("keeps a no-value op row without its value on Apply", async () => {
    const { view } = await mountEmbed({ ref: "/data/vendors" }, NATIVE_3COL);
    const { rows } = openFiltersPanel(view);
    const r = rowParts(rows()[0]);
    r.column.value = "state";
    r.column.dispatchEvent(new Event("change"));
    r.op.value = "notblank";
    r.op.dispatchEvent(new Event("change"));
    applyBtn(view).click();
    expect(view.state.doc.firstChild!.attrs.config).toEqual({
      filters: [{ column: "state", op: "notblank" }],
    });
    view.destroy();
  });

  it("clearing every row on Apply removes the filters key entirely", async () => {
    const { view } = await mountEmbed(
      {
        ref: "/data/vendors",
        config: {
          columns: ["state"],
          filters: [{ column: "state", op: "exact", value: "CA" }],
        },
      },
      NATIVE_3COL,
    );
    const { rows } = openFiltersPanel(view);
    (rows()[0].querySelector(".pm-block-embed-filter-remove") as HTMLButtonElement).click();
    // The trailing blank row survives the removal.
    expect(rows()).toHaveLength(1);
    applyBtn(view).click();
    // filters key gone; unrelated config keys untouched.
    expect(view.state.doc.firstChild!.attrs.config).toEqual({ columns: ["state"] });
    view.destroy();
  });

  it("choosing '– no sort –' on Apply removes the sort key", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors", config: { sort: { column: "population", desc: true } } },
      NATIVE_3COL,
    );
    openFiltersPanel(view);
    const sort = sortControls(view);
    expect(sort.column.value).toBe("population");
    sort.column.value = "";
    applyBtn(view).click();
    expect(view.state.doc.firstChild!.attrs.config).toEqual({});
    view.destroy();
  });

  it("Apply with an unchanged form dispatches nothing", async () => {
    const { view } = await mountEmbed(
      {
        ref: "/data/vendors",
        config: {
          filters: [{ column: "state", op: "exact", value: "CA" }],
          sort: { column: "population", desc: true },
        },
      },
      NATIVE_3COL,
    );
    const dispatch = vi.spyOn(view, "dispatch");
    openFiltersPanel(view);
    applyBtn(view).click();
    expect(dispatch).not.toHaveBeenCalled();
    // …and the menu closed anyway.
    expect(view.dom.querySelector(".pm-block-embed-menu--open")).toBeNull();
    view.destroy();
  });

  it("Cancel discards edits and dispatches nothing", async () => {
    const { view } = await mountEmbed(
      {
        ref: "/data/vendors",
        config: { filters: [{ column: "state", op: "exact", value: "CA" }] },
      },
      NATIVE_3COL,
    );
    const dispatch = vi.spyOn(view, "dispatch");
    const { rows } = openFiltersPanel(view);
    rowParts(rows()[0]).value.value = "WA"; // typing never dispatches
    (
      view.dom.querySelector(".pm-block-embed-filter-cancel") as HTMLButtonElement
    ).click();
    expect(dispatch).not.toHaveBeenCalled();
    expect(view.state.doc.firstChild!.attrs.config).toEqual({
      filters: [{ column: "state", op: "exact", value: "CA" }],
    });
    expect(view.dom.querySelector(".pm-block-embed-menu--open")).toBeNull();
    view.destroy();
  });

  it("hides the Filter & sort… item from read-only viewers", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors" },
      NATIVE_3COL,
      () => false,
    );
    expect(menuLabels(view)).not.toContain("Filter & sort…");
    view.destroy();
  });

  it("shows the filter-count badge to read-only viewers when filters are configured", async () => {
    const { view } = await mountEmbed(
      {
        ref: "/data/vendors",
        config: {
          filters: [
            { column: "state", op: "exact", value: "CA" },
            { column: "state", op: "notblank" },
          ],
        },
      },
      NATIVE_3COL,
      () => false,
    );
    const badge = view.dom.querySelector(".pm-block-embed-filter-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("2");
    // The funnel is an icon (constant SVG), never an emoji character.
    expect(badge!.querySelector("svg")).not.toBeNull();
    view.destroy();
  });

  it("renders no badge when config has no filters", async () => {
    const { view } = await mountEmbed({ ref: "/data/vendors" }, NATIVE_3COL);
    expect(view.dom.querySelector(".pm-block-embed-filter-badge")).toBeNull();
    view.destroy();
  });

  // ── Table filters T04: the per-column ▾ header menu ───────────────────────

  function colMenuBtn(view: EditorView, col: string): HTMLButtonElement {
    return view.dom.querySelector(
      `.pm-block-embed-col-menu-btn[aria-label="Column actions: ${col}"]`,
    ) as HTMLButtonElement;
  }

  function openColMenu(view: EditorView, col: string): HTMLElement {
    const btn = colMenuBtn(view, col);
    btn.click();
    return btn.parentElement!.querySelector(".pm-block-embed-col-menu") as HTMLElement;
  }

  function colItems(menu: HTMLElement): (string | null)[] {
    return [...menu.querySelectorAll(".pm-block-embed-menu-item")].map(
      (el) => el.textContent,
    );
  }

  function clickColItem(menu: HTMLElement, label: string): void {
    (
      [...menu.querySelectorAll(".pm-block-embed-menu-item")].find(
        (el) => el.textContent === label,
      ) as HTMLButtonElement
    ).click();
  }

  const isOpen = (menu: HTMLElement) =>
    menu.classList.contains("pm-block-embed-menu--open");

  it("renders a ▾ menu trigger on every th for editors", async () => {
    const { view } = await mountEmbed({ ref: "/data/vendors" }, NATIVE_3COL);
    const btns = [
      ...view.dom.querySelectorAll(".pm-block-embed-col-menu-btn"),
    ] as HTMLButtonElement[];
    expect(btns).toHaveLength(3);
    expect(btns.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Column actions: id",
      "Column actions: state",
      "Column actions: population",
    ]);
    view.destroy();
  });

  it("renders no ▾ triggers for read-only viewers", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors" },
      NATIVE_3COL,
      () => false,
    );
    expect(view.dom.querySelectorAll(".pm-block-embed-col-menu-btn")).toHaveLength(0);
    view.destroy();
  });

  it("keeps a single menu open: a column menu closes the ⋮ menu and other column menus", async () => {
    const { view } = await mountEmbed({ ref: "/data/vendors" }, NATIVE_3COL);
    // Open the header ⋮ menu first.
    (view.dom.querySelector(".pm-block-embed-menu-btn") as HTMLButtonElement).click();
    const overflow = view.dom.querySelector(
      ".pm-block-embed-head .pm-block-embed-menu",
    ) as HTMLElement;
    expect(isOpen(overflow)).toBe(true);
    // Opening a column menu closes it.
    const first = openColMenu(view, "state");
    expect(isOpen(overflow)).toBe(false);
    expect(isOpen(first)).toBe(true);
    // Opening another column's menu closes the first.
    const second = openColMenu(view, "population");
    expect(isOpen(first)).toBe(false);
    expect(isOpen(second)).toBe(true);
    view.destroy();
  });

  it("Sort ascending writes sort {column} in one step — no desc key at all", async () => {
    const { view } = await mountEmbed({ ref: "/data/vendors" }, NATIVE_3COL);
    const dispatch = vi.spyOn(view, "dispatch");
    const menu = openColMenu(view, "state");
    clickColItem(menu, "Sort ascending");
    expect(dispatch).toHaveBeenCalledTimes(1);
    const config = view.state.doc.firstChild!.attrs.config as {
      sort: Record<string, unknown>;
    };
    expect(config).toEqual({ sort: { column: "state" } });
    // The T03 normalization: ascending is the key's shape, not desc: false.
    expect(Object.keys(config.sort)).toEqual(["column"]);
    await new Promise((r) => setTimeout(r, 0));
    view.destroy();
  });

  it("Sort descending writes sort {column, desc: true}", async () => {
    const { view } = await mountEmbed({ ref: "/data/vendors" }, NATIVE_3COL);
    const menu = openColMenu(view, "population");
    clickColItem(menu, "Sort descending");
    expect(view.state.doc.firstChild!.attrs.config).toEqual({
      sort: { column: "population", desc: true },
    });
    await new Promise((r) => setTimeout(r, 0));
    view.destroy();
  });

  it("hides the active ascending item and offers Clear sort, which deletes the key", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors", config: { sort: { column: "state" } } },
      NATIVE_3COL,
    );
    const menu = openColMenu(view, "state");
    const labels = colItems(menu);
    expect(labels).not.toContain("Sort ascending");
    expect(labels).toContain("Sort descending");
    expect(labels).toContain("Clear sort");
    clickColItem(menu, "Clear sort");
    expect(view.state.doc.firstChild!.attrs.config).toEqual({});
    await new Promise((r) => setTimeout(r, 0));
    view.destroy();
  });

  it("hides the active descending item; other columns get no Clear sort", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors", config: { sort: { column: "population", desc: true } } },
      NATIVE_3COL,
    );
    const sorted = colItems(openColMenu(view, "population"));
    expect(sorted).not.toContain("Sort descending");
    expect(sorted).toContain("Sort ascending");
    expect(sorted).toContain("Clear sort");
    const other = colItems(openColMenu(view, "state"));
    expect(other).toContain("Sort ascending");
    expect(other).toContain("Sort descending");
    expect(other).not.toContain("Clear sort");
    view.destroy();
  });

  it("Hide this column seeds from allColumns and writes the remainder", async () => {
    const { view } = await mountEmbed({ ref: "/data/vendors" }, NATIVE_3COL);
    const dispatch = vi.spyOn(view, "dispatch");
    const menu = openColMenu(view, "state");
    clickColItem(menu, "Hide this column");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(view.state.doc.firstChild!.attrs.config).toEqual({
      columns: ["id", "population"],
    });
    await new Promise((r) => setTimeout(r, 0));
    view.destroy();
  });

  it("offers no Hide item on the last visible column; Show all deletes the key", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors", config: { columns: ["state"] } },
      NATIVE_3COL,
    );
    // Projection renders only the selected column.
    expect(view.dom.querySelectorAll("th")).toHaveLength(1);
    const menu = openColMenu(view, "state");
    const labels = colItems(menu);
    expect(labels).not.toContain("Hide this column");
    expect(labels).toContain("Show all columns");
    clickColItem(menu, "Show all columns");
    expect(view.state.doc.firstChild!.attrs.config).toEqual({});
    await new Promise((r) => setTimeout(r, 0));
    view.destroy();
  });

  it("offers Show all columns only while config.columns is set", async () => {
    const { view } = await mountEmbed({ ref: "/data/vendors" }, NATIVE_3COL);
    expect(colItems(openColMenu(view, "state"))).not.toContain("Show all columns");
    view.destroy();
  });

  it("re-gates the column menus when editability flips mid-session", async () => {
    let editable = true;
    const { view, nodeView } = await mountEmbed(
      { ref: "/data/vendors" },
      NATIVE_3COL,
      () => editable,
    );
    expect(view.dom.querySelectorAll(".pm-block-embed-col-menu-btn")).toHaveLength(3);

    editable = false;
    view.setProps({ editable: () => editable });
    nodeView.update(view.state.doc.firstChild!);
    expect(view.dom.querySelectorAll(".pm-block-embed-col-menu-btn")).toHaveLength(0);

    editable = true;
    view.setProps({ editable: () => editable });
    nodeView.update(view.state.doc.firstChild!);
    expect(view.dom.querySelectorAll(".pm-block-embed-col-menu-btn")).toHaveLength(3);
    view.destroy();
  });

  it("shows the passive sort indicator to read-only viewers (desc icon)", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors", config: { sort: { column: "population", desc: true } } },
      NATIVE_3COL,
      () => false,
    );
    const ind = view.dom.querySelector(".pm-block-embed-sort-ind") as HTMLElement;
    expect(ind).not.toBeNull();
    expect(ind.dataset.dir).toBe("desc");
    // It sits in the sorted column's header, as the sort-down icon.
    expect(ind.closest("th")!.textContent).toBe("population");
    expect(ind.querySelector("path")!.getAttribute("d")!.startsWith("M3.5 2.5")).toBe(
      true,
    );
    view.destroy();
  });

  it("uses the sort-up icon for an ascending sort", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors", config: { sort: { column: "state" } } },
      NATIVE_3COL,
    );
    const ind = view.dom.querySelector(".pm-block-embed-sort-ind") as HTMLElement;
    expect(ind.dataset.dir).toBe("asc");
    expect(ind.closest("th")!.childNodes[0].textContent).toBe("state");
    expect(ind.querySelector("path")!.getAttribute("d")!.startsWith("M3.5 12.5")).toBe(
      true,
    );
    // Only the sorted column carries an indicator.
    expect(view.dom.querySelectorAll(".pm-block-embed-sort-ind")).toHaveLength(1);
    view.destroy();
  });

  // ── Table filters T05: the summary line ───────────────────────────────────

  it("renders '<count> rows <description>' between the header and the table", async () => {
    const view = await build("/data/vendors", {
      columns: ["id", "state"],
      rows: [[1, "CA"]],
      count: 42,
      human_description_en: "where state = CA",
    });
    const summary = view.dom.querySelector(".pm-block-embed-summary") as HTMLElement;
    expect(summary).not.toBeNull();
    expect(summary.textContent).toBe("42 rows where state = CA");
    expect(summary.previousElementSibling!.classList.contains("pm-block-embed-head")).toBe(
      true,
    );
    expect(summary.nextElementSibling!.classList.contains("pm-block-embed-scroll")).toBe(
      true,
    );
    // The footer truncation info is unchanged alongside it.
    expect(
      view.dom.querySelector(".pm-block-embed-footer-info")!.textContent,
    ).toContain("of 42 rows");
  });

  it("keeps a hostile description inert (single text node, no markup)", async () => {
    const view = await build("/data/vendors", {
      columns: ["id"],
      rows: [[1]],
      count: 1,
      human_description_en: "where note = <script>alert(1)</script>",
    });
    const summary = view.dom.querySelector(".pm-block-embed-summary") as HTMLElement;
    expect(summary.querySelector("script")).toBeNull();
    expect(summary.childNodes).toHaveLength(1);
    expect(summary.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(summary.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders no summary line when the description is absent (older Datasette)", async () => {
    const view = await build("/data/vendors", {
      columns: ["id"],
      rows: [[1]],
      count: 1,
    });
    expect(view.dom.querySelector(".pm-block-embed-summary")).toBeNull();
  });

  it("shows the summary line to read-only viewers too", async () => {
    const { view } = await mountEmbed(
      { ref: "/data/vendors" },
      {
        ...NATIVE_3COL,
        count: 7,
        human_description_en: "where state = CA",
      },
      () => false,
    );
    expect(
      view.dom.querySelector(".pm-block-embed-summary")!.textContent,
    ).toBe("7 rows where state = CA");
    view.destroy();
  });
});
