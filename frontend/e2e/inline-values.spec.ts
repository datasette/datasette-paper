/**
 * E2E for inline SQL values.
 *
 * The webServer attaches a `data` database (db name `datasette-paper-e2e-data`)
 * with a `vendors` table (30 rows) and grants execute-sql by default. Covers
 * the full authoring loop:
 *   - the Sources panel adds a named source (with a Test probe)
 *   - the `${{` trigger inserts a value chip referencing it
 *   - the chip renders the live value, and survives a reload (re-fetched)
 *
 * Locators are scoped to #app-root (the debug-bar injects its own controls).
 */
import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper } from "./helpers";

const E2E_DB = "datasette-paper-e2e-data";

test.describe("inline sql values", () => {
  test("add source via panel, insert value via ${{, render + reload", async ({ page }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");

    // The Sources panel starts expanded in the right sidebar; add a source.
    await app.locator(".sources-panel-add").click();
    await app.locator(".sources-panel-field input").fill("vendors");
    await app.locator(".sources-panel-field select").selectOption(E2E_DB);
    await app
      .locator(".sources-panel-field textarea")
      .fill("select count(*) as n from vendors");

    // Test runs the probe and reports the column.
    await app.getByRole("button", { name: "Test" }).click();
    await expect(app.locator(".sources-panel-probe")).toContainText("n", {
      timeout: 10000,
    });

    // Save → a source card lands in the doc.
    await app.getByRole("button", { name: "Save" }).click();
    await expect(app.locator(".pm-source-card")).toBeVisible({ timeout: 10000 });

    // Insert a value via the `${{` trigger: place the cursor in the empty
    // first paragraph (the source card is a tall block lower down — clicking
    // the editor center would land inside its SQL), type the source + column,
    // then commit the highlighted column from the popup.
    await app.locator(".ProseMirror p").first().click();
    await page.keyboard.type("Total: ${{vendors.n");
    await expect(app.locator(".pm-value-popup")).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Enter");

    // The chip renders the live value (vendors has 30 rows).
    const chip = app.locator(".pm-value");
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip).toHaveText("30", { timeout: 10000 });

    // Survives a reload — the chip re-fetches on mount.
    await page.reload();
    const chipAfter = page.locator("#app-root .pm-value");
    await expect(chipAfter).toBeVisible({ timeout: 10000 });
    await expect(chipAfter).toHaveText("30", { timeout: 10000 });
  });
});
