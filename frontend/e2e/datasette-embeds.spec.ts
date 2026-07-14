/**
 * E2E for the `/` slash menu and the Datasette embed authoring path.
 *
 * The webServer attaches a `data` database with a `vendors` table (30 rows),
 * so the embed NodeView resolves and renders real data. Covers:
 *   - the slash menu opens in an empty block and runs a command (Heading 1)
 *   - the "Embed a table" command (/embed) opens the picker, inserts an embed, and
 *     the embed renders a capped table — surviving a reload (proves the node
 *     persists `ref` only and the NodeView re-fetches on mount).
 *   - the ⋮ "Columns…" picker restricts the embed to a column subset (hiding
 *     the PK), and the selection persists across reload (config round-trips).
 *   - the filter/sort config surface (see "block-embed filters" below): the
 *     ⋮ "Filter & sort…" panel, the per-column ▾ header menu, pasting a
 *     filtered table URL, and the read-only view-mode presentation.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { createPaper, gotoPaper, waitForServerVersion } from "./helpers";

/**
 * Insert a `vendors` block embed via the `/embed` slash-menu picker and wait
 * for it to render real data (the shared authoring path of the specs below).
 */
async function insertVendorsEmbed(page: Page): Promise<Locator> {
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await page.keyboard.type("/embed");
  const menu = page.locator(".pm-slash-menu");
  await expect(menu).toBeVisible({ timeout: 10000 });
  await menu.locator(".pm-slash-item", { hasText: "Embed a table" }).click();
  const dialog = page.locator(".ds-embed-dialog");
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await dialog.locator(".ds-embed-search").fill("vendors");
  const result = dialog.locator(".ds-embed-result", { hasText: "vendors" });
  await expect(result).toBeVisible({ timeout: 10000 });
  await result.click();
  const embed = page.locator(".pm-block-embed");
  await expect(embed).toBeVisible({ timeout: 10000 });
  await expect
    .poll(async () => embed.locator("table").innerText(), {
      timeout: 10000,
      message: "embed never rendered table rows",
    })
    .toContain("Vendor 1");
  return embed;
}

/**
 * Dispatch a synthetic paste of `text` into the focused editor (the
 * image.spec.ts pattern — headless chromium has no OS clipboard).
 */
async function pasteText(page: Page, text: string): Promise<void> {
  await page.locator(".ProseMirror").click();
  await page.evaluate((value) => {
    const editable = document.querySelector(".ProseMirror") as HTMLElement;
    editable.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", value);
    editable.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
}

test.describe("slash menu + datasette embed", () => {
  test("/ menu runs a command (Heading 1)", async ({ page }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("/head");

    const menu = page.locator(".pm-slash-menu");
    await expect(menu).toBeVisible({ timeout: 10000 });
    await expect(menu.locator(".pm-slash-item", { hasText: "Heading 1" })).toBeVisible();

    await page.keyboard.press("Enter");

    // The block became an H1 and the "/head" trigger text is gone.
    await expect(page.locator(".ProseMirror h1")).toBeVisible({ timeout: 10000 });
    await expect(editor).not.toContainText("/head");
  });

  test("/ Datasette embed picker inserts an embed that renders + survives reload", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("/embed");

    // The native embed is now two commands ("Embed a table" / "Embed a
    // database"); pick the table one, which lists tables + views.
    const menu = page.locator(".pm-slash-menu");
    await expect(menu).toBeVisible({ timeout: 10000 });
    await menu.locator(".pm-slash-item", { hasText: "Embed a table" }).click();

    // The picker dialog opens; search for the vendors table and choose it.
    const dialog = page.locator(".ds-embed-dialog");
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await dialog.locator(".ds-embed-search").fill("vendors");
    const result = dialog.locator(".ds-embed-result", { hasText: "vendors" });
    await expect(result).toBeVisible({ timeout: 10000 });
    await result.click();

    // The embed renders a capped table with real data.
    const embed = page.locator(".pm-block-embed");
    await expect(embed).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => embed.locator("table").innerText(), {
        timeout: 10000,
        message: "embed never rendered table rows",
      })
      .toContain("Vendor 1");
    // Footer: inline limit dropdown (default 10) + total ("showing [10] of 30 rows").
    await expect(embed.locator(".pm-block-embed-rows")).toHaveValue("10");
    await expect(embed).toContainText("of 30 rows");
    // Footer layout (ticket 02): the "open in Datasette" link is the FIRST
    // footer child (left); the count/limit info is pushed to the right.
    await expect(
      embed.locator(".pm-block-embed-footer > :first-child"),
    ).toHaveClass(/pm-block-embed-footer-link/);

    // Export menu: ⋮ → Download ▸ opens a CSV/JSON submenu; CSV downloads the
    // client-held rows (30 total, 10 held → the partial-slice warning shows).
    await embed.locator(".pm-block-embed-menu-btn").click();
    // :not(...) — the per-column ▾ menus share the base menu class.
    const exportMenu = embed.locator(
      ".pm-block-embed-menu:not(.pm-block-embed-col-menu)",
    );
    await expect(exportMenu).toHaveClass(/pm-block-embed-menu--open/);
    // Top level: Download + Copy submenu parents.
    await expect(exportMenu.getByText("Download", { exact: true })).toBeVisible();
    await expect(exportMenu.getByText("Copy", { exact: true })).toBeVisible();
    // Open Download ▸ → the CSV/JSON leaves appear.
    await exportMenu.getByText("Download", { exact: true }).click();
    const csvLeaf = exportMenu.getByText("CSV", { exact: true });
    await expect(csvLeaf).toBeVisible();
    await expect(exportMenu.getByText("JSON", { exact: true })).toBeVisible();
    // Clicking CSV triggers a client-side download of the held rows.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      csvLeaf.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/vendors\.csv$/);

    // Persisted as ref-only: after a reload the NodeView re-fetches + renders.
    await waitForServerVersion(page, host.id, 1);
    await page.reload();
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });
    const reloaded = page.locator(".pm-block-embed");
    await expect(reloaded).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => reloaded.locator("table").innerText(), {
        timeout: 10000,
        message: "embed did not re-render after reload",
      })
      .toContain("Vendor 1");
  });

  test("⋮ Columns… restricts the embed to a subset that survives reload", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    // Insert a vendors embed via the slash-menu picker.
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("/embed");
    const menu = page.locator(".pm-slash-menu");
    await expect(menu).toBeVisible({ timeout: 10000 });
    await menu.locator(".pm-slash-item", { hasText: "Embed a table" }).click();
    const dialog = page.locator(".ds-embed-dialog");
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await dialog.locator(".ds-embed-search").fill("vendors");
    const result = dialog.locator(".ds-embed-result", { hasText: "vendors" });
    await expect(result).toBeVisible({ timeout: 10000 });
    await result.click();

    const embed = page.locator(".pm-block-embed");
    await expect(embed).toBeVisible({ timeout: 10000 });
    // Both columns (PK `id` + `name`) render before any selection.
    await expect
      .poll(async () => embed.locator("thead th").allInnerTexts(), { timeout: 10000 })
      .toEqual(["id", "name"]);

    // Open the ⋮ menu → "Columns…". The PK `id` is locked on (checked +
    // disabled) — Datasette always includes it — so hide `name` instead.
    await embed.locator(".pm-block-embed-menu-btn").click();
    await embed
      .locator(".pm-block-embed-menu-item", { hasText: "Columns…" })
      .click();
    const idBox = embed
      .locator(".pm-block-embed-columns-item", { hasText: "id" })
      .locator("input");
    await expect(idBox).toBeChecked();
    await expect(idBox).toBeDisabled();
    await embed
      .locator(".pm-block-embed-columns-item", { hasText: "name" })
      .locator("input")
      .uncheck();
    await embed.locator(".pm-block-embed-columns-apply").click();

    // The embed re-fetches/re-renders to just the PK `id` (name is gone).
    await expect
      .poll(async () => embed.locator("thead th").allInnerTexts(), { timeout: 10000 })
      .toEqual(["id"]);

    // The selection persists across reload (config.columns round-trips through
    // the step log + snapshot, not just markdown). Insert = v1, Apply = v2.
    await waitForServerVersion(page, host.id, 2);
    await page.reload();
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });
    const reloaded = page.locator(".pm-block-embed");
    await expect(reloaded).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => reloaded.locator("thead th").allInnerTexts(), {
        timeout: 10000,
        message: "column selection did not persist across reload",
      })
      .toEqual(["id"]);
  });
});

// @feat embed-filters: e2e — filter panel, header sort menu, filtered-URL paste, read-only view
test.describe("block-embed filters", () => {
  // The e2e `vendors` fixture is 30 rows, names "Vendor 1"…"Vendor 30" —
  // `name contains "Vendor 1"` matches Vendor 1 + Vendor 10-19 = 11 rows.
  const FILTERED_URL =
    "/datasette-paper-e2e-data/vendors?name__contains=Vendor+1&_sort_desc=id";

  test("⋮ Filter & sort… applies a shared filter that survives reload", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);
    const embed = await insertVendorsEmbed(page);
    await expect(embed).toContainText("of 30 rows");

    // ⋮ → Filter & sort… swaps the menu body for the filter form.
    await embed.locator(".pm-block-embed-menu-btn").click();
    await embed
      .locator(".pm-block-embed-menu-item", { hasText: "Filter & sort…" })
      .click();
    const panel = embed.locator(".pm-block-embed-filters");
    await expect(panel).toBeVisible();
    // Shared-view messaging: the notice + the honest Apply label (this config
    // is document state — it changes what every reader sees).
    await expect(panel.locator(".pm-block-embed-shared-notice")).toContainText(
      "Shared view",
    );
    const apply = panel.locator(".pm-block-embed-filter-apply");
    await expect(apply).toHaveText("Apply for everyone");

    // No configured filters yet — Add filter grows a blank row to fill:
    // name contains "Vendor 1".
    await panel.locator(".pm-block-embed-filter-add").click();
    const row = panel.locator(".pm-block-embed-filter-row").first();
    await row.locator(".pm-block-embed-filter-column").selectOption("name");
    await row.locator(".pm-block-embed-filter-op").selectOption("contains");
    await row.locator(".pm-block-embed-filter-value").fill("Vendor 1");
    await apply.click();

    // The embed re-fetches: 11 of 30 rows, funnel badge, structured summary.
    await expect(embed).toContainText("of 11 rows", { timeout: 10000 });
    const badge = embed.locator(".pm-block-embed-filter-badge");
    await expect(badge).toBeVisible();
    const summary = embed.locator(".pm-block-embed-summary");
    await expect(summary.locator(".pm-block-embed-summary-col")).toHaveText("name");
    await expect(summary.locator(".pm-block-embed-summary-val")).toHaveText("Vendor 1");

    // The badge itself reopens the filter panel (shortcut for the ⋮ item).
    await badge.click();
    await expect(embed.locator(".pm-block-embed-filters")).toBeVisible();
    await expect(
      embed.locator(".pm-block-embed-filter-row").first().locator(
        ".pm-block-embed-filter-column",
      ),
    ).toHaveValue("name");
    await page.keyboard.press("Escape");

    // The filter persists across reload (config.filters round-trips through
    // the step log). Insert = v1, Apply = v2.
    await waitForServerVersion(page, host.id, 2);
    await page.reload();
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });
    const reloaded = page.locator(".pm-block-embed");
    await expect(reloaded).toBeVisible({ timeout: 10000 });
    await expect(reloaded).toContainText("of 11 rows", { timeout: 10000 });
    await expect(reloaded.locator(".pm-block-embed-filter-badge")).toBeVisible();
    await expect(
      reloaded.locator(".pm-block-embed-summary .pm-block-embed-summary-val"),
    ).toHaveText("Vendor 1");
  });

  test("column header ▾ menu sorts descending with an indicator", async ({
    page,
  }) => {
    const { url } = await createPaper(page);
    await gotoPaper(page, url);
    const embed = await insertVendorsEmbed(page);

    // Unsorted: rowid order, first cell of the `id` column is 1.
    const firstCell = embed.locator("tbody tr").first().locator("td").first();
    await expect(firstCell).toHaveText("1");

    // Per-column ▾ menu on `id` → Sort descending (one config write).
    await embed
      .locator('.pm-block-embed-col-menu-btn[aria-label="Column actions: id"]')
      .click();
    await embed
      .locator(".pm-block-embed-menu--open .pm-block-embed-menu-item", {
        hasText: "Sort descending",
      })
      .click();

    // The re-fetch flips the order and renders the ▼ indicator.
    await expect(firstCell).toHaveText("30", { timeout: 10000 });
    await expect(
      embed.locator('.pm-block-embed-sort-ind[data-dir="desc"]'),
    ).toBeVisible();
  });

  test("pasting a filtered table URL creates an equally filtered embed", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    // Paste into the empty top-level paragraph → block embed whose config
    // carries the URL's `name__contains` + `_sort_desc` params.
    await pasteText(page, FILTERED_URL);
    const embed = page.locator(".pm-block-embed");
    await expect(embed).toBeVisible({ timeout: 10000 });
    await expect(embed).toContainText("of 11 rows", { timeout: 10000 });
    // Sorted descending by id: 19 (of 1, 10-19) renders first, with the ▼.
    await expect(embed.locator("tbody tr").first().locator("td").first()).toHaveText(
      "19",
    );
    await expect(
      embed.locator('.pm-block-embed-sort-ind[data-dir="desc"]'),
    ).toBeVisible();
    // Sort moved to the header pill; the summary carries only the filter.
    await expect(
      embed.locator(".pm-block-embed-sort-pill"),
    ).toContainText("id");
    await expect(
      embed.locator(".pm-block-embed-summary .pm-block-embed-summary-val"),
    ).toHaveText("Vendor 1");
    await expect(embed.locator(".pm-block-embed-filter-badge")).toBeVisible();

    // The pasted config round-trips through the fence/step log.
    await waitForServerVersion(page, host.id, 1);
    await page.reload();
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });
    const reloaded = page.locator(".pm-block-embed");
    await expect(reloaded).toBeVisible({ timeout: 10000 });
    await expect(reloaded).toContainText("of 11 rows", { timeout: 10000 });
    await expect(
      reloaded.locator('.pm-block-embed-sort-ind[data-dir="desc"]'),
    ).toBeVisible();
  });

  test("view mode keeps summary/badge/indicator but drops config controls", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    // Build a filtered+sorted embed in one step via paste, then flip the
    // app's view-mode toggle (the e2e actor keeps edit permission — this is
    // the editable-UI gate, not a permission denial).
    await pasteText(page, FILTERED_URL);
    const embed = page.locator(".pm-block-embed");
    await expect(embed).toBeVisible({ timeout: 10000 });
    await expect(embed).toContainText("of 11 rows", { timeout: 10000 });

    // Scoped to #app-root: the dev debug bar injects its own controls.
    await page
      .locator("#app-root")
      .getByRole("button", { name: "View", exact: true })
      .click();
    await expect(page.locator(".paper-toolbar")).toHaveCount(0);

    // Passive read-signals stay visible to viewers: the structured filter
    // summary, the in-table sort indicator, the header sort pill + funnel badge.
    await expect(
      embed.locator(".pm-block-embed-summary .pm-block-embed-summary-val"),
    ).toHaveText("Vendor 1");
    await expect(
      embed.locator('.pm-block-embed-sort-ind[data-dir="desc"]'),
    ).toBeVisible();
    await expect(embed.locator(".pm-block-embed-sort-pill")).toContainText("id");
    await expect(embed.locator(".pm-block-embed-filter-badge")).toBeVisible();

    // …while every config-writing control is gone: no per-column ▾ menus,
    // and the ⋮ menu keeps its export items but loses Filter & sort…/Columns….
    await expect(embed.locator(".pm-block-embed-col-menu-btn")).toHaveCount(0);
    await embed.locator(".pm-block-embed-menu-btn").click();
    const menu = embed.locator(".pm-block-embed-menu");
    await expect(menu).toHaveClass(/pm-block-embed-menu--open/);
    await expect(
      menu.locator(".pm-block-embed-menu-item", { hasText: "Filter & sort…" }),
    ).toHaveCount(0);
    await expect(
      menu.locator(".pm-block-embed-menu-item", { hasText: "Columns…" }),
    ).toHaveCount(0);
    await expect(menu.getByText("Download", { exact: true })).toBeVisible();
    await expect(menu.getByText("Copy", { exact: true })).toBeVisible();
  });

  test("copying an embed puts its Datasette URL (with config) on the clipboard", async ({
    page,
  }) => {
    const { url } = await createPaper(page);
    await gotoPaper(page, url);
    // A filtered + sorted embed, so the copied URL must carry the config query.
    await pasteText(page, FILTERED_URL);
    const embed = page.locator(".pm-block-embed");
    await expect(embed).toBeVisible({ timeout: 10000 });
    await expect(embed).toContainText("of 11 rows", { timeout: 10000 });

    // Inserting the embed leaves it node-selected (clicking a cell now selects
    // *text* for copying, not the node — see the cell-selection test). Read what
    // ProseMirror writes on a real copy event, straight off the event's
    // clipboardData (headless chromium has no OS clipboard).
    const copied = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (window as any).__pmView;
      const sel = view.state.selection;
      const dt = new DataTransfer();
      view.dom.dispatchEvent(
        new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
      return {
        selNode: sel.node ? sel.node.type.name : null,
        text: dt.getData("text/plain"),
      };
    });

    // The freshly-inserted embed is node-selected…
    expect(copied.selNode).toBe("block_embed");
    // …and text/plain is its full same-origin Datasette URL, filter + sort intact.
    const u = new URL(copied.text);
    expect(u.origin).toBe(new URL(page.url()).origin);
    expect(u.pathname).toBe("/datasette-paper-e2e-data/vendors");
    expect(u.searchParams.get("name__contains")).toBe("Vendor 1");
    expect(u.searchParams.get("_sort_desc")).toBe("id");
  });

  test("selecting a cell's text and copying yields the text, not the node URL", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { url } = await createPaper(page);
    await gotoPaper(page, url);
    // A realistic doc: some prose, then the embed on its own line.
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("Our vendors:");
    await page.keyboard.press("Enter");
    await pasteText(page, "/datasette-paper-e2e-data/vendors");
    const embed = page.locator(".pm-block-embed");
    await expect(embed).toBeVisible({ timeout: 10000 });
    await expect(embed).toContainText("Vendor 1", { timeout: 10000 });

    // The embed is node-selected from insertion. Dragging across a cell must
    // drop that node-selection and select the cell text instead.
    const cell = embed.locator("tbody tr").first().locator("td").nth(1);
    const box = (await cell.boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
      .toBe("Vendor 1");

    // A real copy keystroke lands the cell text on the OS clipboard — NOT the
    // embed's Datasette URL (which is what copying the whole node gives).
    await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("Vendor 1");
  });

  test("refreshing reserves the block's height so the doc doesn't jump", async ({
    page,
  }) => {
    const { url } = await createPaper(page);
    await gotoPaper(page, url);
    await pasteText(page, "/datasette-paper-e2e-data/vendors");
    const embed = page.locator(".pm-block-embed");
    await expect(embed).toBeVisible({ timeout: 10000 });
    await expect(embed).toContainText("Vendor 1", { timeout: 10000 });
    const before = await embed.evaluate((el) => (el as HTMLElement).offsetHeight);

    // Hold the refetch so the loading state is observable.
    await page.route("**/vendors.json**", async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await embed.locator(".pm-block-embed-refresh").click();

    // Loading: the skeleton is up, but the block keeps its height — no collapse
    // to a short block (which would shift everything below it).
    await expect(embed.locator(".pm-block-embed-skeleton")).toBeVisible();
    expect(await embed.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(before);

    // Loaded: back to the table, the reservation cleared.
    await page.unroute("**/vendors.json**");
    await expect(embed).toContainText("Vendor 1", { timeout: 10000 });
    expect(await embed.evaluate((el) => (el as HTMLElement).style.minHeight)).toBe("");
  });
});
