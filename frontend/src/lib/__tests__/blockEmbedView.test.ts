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
  const view = new BlockEmbedView(node, {} as unknown as EditorView, () => 0);
  // Let the async load() resolve.
  await new Promise((r) => setTimeout(r, 0));
  return view;
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
    expect([...view.dom.querySelectorAll("th")].map((t) => t.textContent)).toEqual([
      "id",
      "name",
    ]);
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
    const view = new BlockEmbedView(node, {} as unknown as EditorView, () => 0);
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
      const view = new BlockEmbedView(node, {} as unknown as EditorView, () => 0);
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
      new BlockEmbedView(node, {} as unknown as EditorView, () => 0);
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
      const view = new BlockEmbedView(node, {} as unknown as EditorView, () => 0);
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
});
