/**
 * E2E for the SQL query block.
 *
 * The webServer attaches a `data` database with a `vendors` table (30 rows)
 * and grants execute-sql by default, so the block fetches real results from
 * Datasette's native /{db}/-/query.json API. Covers:
 *   - `/sql` inserts a block whose db <select> defaults to `data`
 *   - typing a query + Run renders the results as a table
 *   - Hide SQL collapses the editor (results stay), Show SQL re-expands
 *   - the SQL text + db persist and auto-run on reload (results re-render)
 */
import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper } from "./helpers";

const BASE = `/-/paper`;

test.describe("sql query block", () => {
  test("/sql inserts, runs, hides/shows, and survives reload", async ({ page }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("/sql");

    const menu = page.locator(".pm-slash-menu");
    await expect(menu).toBeVisible({ timeout: 10000 });
    await expect(menu.locator(".pm-slash-item", { hasText: "SQL query" })).toBeVisible();
    await page.keyboard.press("Enter");

    const block = page.locator(".pm-sql-block");
    await expect(block).toBeVisible({ timeout: 10000 });
    // The db <select> defaults to the only queryable database, `data`.
    await expect(block.locator(".pm-sql-block-db")).toHaveValue("datasette-paper-e2e-data", { timeout: 10000 });

    // Type a query into the editable code area. Editing makes results stale →
    // the Run button lights up (gets the --stale modifier).
    await block.locator(".pm-sql-block-code").click();
    await page.keyboard.type("select * from vendors");
    await expect(block.locator(".pm-sql-block-run")).toHaveClass(/pm-sql-block-run--stale/);
    await block.locator(".pm-sql-block-run").click();
    // After running, results match the SQL → Run goes quiet again.
    await expect(block.locator(".pm-sql-block-run")).not.toHaveClass(/pm-sql-block-run--stale/);

    await expect(block.locator("table")).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => block.locator("table").innerText(), {
        timeout: 10000,
        message: "results table never rendered",
      })
      .toContain("Vendor 1");

    // Column headers from the query (vendors: id / name).
    await expect(block.locator("thead th").first()).toHaveText("id");
    // First page is 10 of 30 rows, with a pager and a right-aligned link.
    await expect(block.locator("tbody tr")).toHaveCount(10);
    await expect(block).toContainText("1–10 of 30");
    await expect(block.locator(".pm-sql-block-page-label")).toHaveText("1 / 3");
    const dsLink = block.locator(".pm-sql-block-footer-link");
    await expect(dsLink).toHaveText(/open in Datasette/);
    await expect(dsLink).toHaveAttribute("href", /\/-\/query\?sql=/);

    // Page 2 → rows 11–20.
    await block.locator(".pm-sql-block-page-btn").last().click();
    await expect(block).toContainText("11–20 of 30");
    await expect(block.locator("tbody")).toContainText("Vendor 11");
    // Bump page size to 100 → all 30 on one page, pager gone.
    await block.locator(".pm-sql-block-rows").selectOption("100");
    await expect(block.locator("tbody tr")).toHaveCount(30);
    await expect(block.locator(".pm-sql-block-pager")).toHaveCount(0);

    // Export menu: ⋮ opens Copy as CSV / Copy as JSON / Download CSV.
    await block.locator(".pm-sql-block-menu-btn").click();
    const items = block.locator(".pm-sql-block-menu--open .pm-sql-block-menu-item");
    await expect(items).toHaveText(["Copy as CSV", "Copy as JSON", "Download CSV"]);
    await page.keyboard.press("Escape");
    await expect(block.locator(".pm-sql-block-menu--open")).toHaveCount(0);

    // Hide SQL: the editor collapses, the results table stays visible.
    await block.locator(".pm-sql-block-toggle").click();
    await expect(block).toHaveClass(/is-hidden/);
    await expect(block.locator(".pm-sql-block-code")).toBeHidden();
    await expect(block.locator("table")).toBeVisible();
    await expect(block.locator(".pm-sql-block-toggle")).toContainText("Show SQL");

    // Show SQL again.
    await block.locator(".pm-sql-block-toggle").click();
    await expect(block).not.toHaveClass(/is-hidden/);
    await expect(block.locator(".pm-sql-block-code")).toBeVisible();

    // Wait for the SQL text to persist server-side, then reload.
    await expect
      .poll(
        async () => {
          const r = await page.request.get(`${BASE}/api/docs/${host.id}/document`);
          if (!r.ok()) return "";
          return (await r.json()).content_markdown as string;
        },
        { timeout: 10000, message: "SQL never persisted" },
      )
      .toContain("```sql db=datasette-paper-e2e-data\nselect * from vendors");

    await page.reload();
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });
    const reloaded = page.locator(".pm-sql-block");
    await expect(reloaded).toBeVisible({ timeout: 10000 });
    // Auto-run on mount re-renders the results without clicking Run.
    await expect
      .poll(async () => reloaded.locator("table").innerText(), {
        timeout: 10000,
        message: "results did not re-render after reload",
      })
      .toContain("Vendor 1");
  });
});
