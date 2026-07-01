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
 */
import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper, waitForServerVersion } from "./helpers";

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

    // Export menu (ticket 01): the ⋮ menu offers native streaming downloads.
    await embed.locator(".pm-block-embed-menu-btn").click();
    const exportMenu = embed.locator(".pm-block-embed-menu");
    await expect(exportMenu).toHaveClass(/pm-block-embed-menu--open/);
    await expect(
      exportMenu.locator(".pm-block-embed-menu-item", {
        hasText: "Download CSV",
      }),
    ).toHaveAttribute("href", /\/vendors\.csv\?_stream=on/);
    await expect(
      exportMenu.locator(".pm-block-embed-menu-item", {
        hasText: "Download JSON",
      }),
    ).toHaveAttribute("href", /\/vendors\.json\?_shape=array/);
    // Copy is honestly labelled as the visible page (30 rows total, 10 held).
    await expect(
      exportMenu.locator(".pm-block-embed-menu-item", { hasText: "Copy as CSV" }),
    ).toContainText("page");
    // Close the menu before continuing.
    await page.keyboard.press("Escape");

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

    // Open the ⋮ menu → "Columns…", uncheck the PK `id`, Apply.
    await embed.locator(".pm-block-embed-menu-btn").click();
    await embed
      .locator(".pm-block-embed-menu-item", { hasText: "Columns…" })
      .click();
    const idRow = embed.locator(".pm-block-embed-columns-item", { hasText: "id" });
    await idRow.locator("input").uncheck();
    await embed.locator(".pm-block-embed-columns-apply").click();

    // The embed re-fetches/re-renders to just `name` (the PK is gone).
    await expect
      .poll(async () => embed.locator("thead th").allInnerTexts(), { timeout: 10000 })
      .toEqual(["name"]);
    await expect(embed.locator("table")).toContainText("Vendor 1");

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
      .toEqual(["name"]);
  });
});
