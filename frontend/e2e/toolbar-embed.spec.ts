/**
 * E2E for inserting a Datasette embed from the toolbar's ＋ Insert menu — the
 * third entry point for a Datasette embed (after URL paste and the `/` slash
 * menu).
 *
 * The webServer attaches a `data` database with a `vendors` table (30 rows),
 * so the inserted embed resolves and renders real data — the same fixture
 * `datasette-embeds.spec.ts` uses. The e2e webServer loads the sample plugin
 * (`--plugins-dir ../tests/sample-plugin`), which registers extra embed
 * providers; each provider is its own row in the ＋ Insert menu now. We click
 * the native "Embed a table" row to open the picker dialog, then assert the
 * same `block_embed` result the slash-menu spec asserts, proving the toolbar
 * reuses the existing picker + insert path.
 *
 * Locators are scoped to `#app-root` — the debug-bar injects an "act as"
 * <select> outside it (see the e2e-baseline notes).
 */
import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper, insertViaMenu, openInsertMenu } from "./helpers";

test.describe("toolbar embed dropdown", () => {
  test("toolbar control opens the picker and inserts a Datasette embed", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");

    // Focus the editor so the edit-mode toolbar is mounted, then open the
    // native Datasette embed picker from the ＋ Insert menu.
    await app.locator(".ProseMirror").click();
    await insertViaMenu(page, "Embed a table");

    // The existing picker dialog opens; search for the vendors table.
    const dialog = app.locator(".ds-embed-dialog");
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await dialog.locator(".ds-embed-search").fill("vendors");
    const result = dialog.locator(".ds-embed-result", { hasText: "vendors" });
    await expect(result).toBeVisible({ timeout: 10000 });
    await result.click();

    // Same result as the slash-menu path: a block_embed renders real rows.
    const embed = app.locator(".pm-block-embed");
    await expect(embed).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => embed.locator("table").innerText(), {
        timeout: 10000,
        message: "embed never rendered table rows",
      })
      .toContain("Vendor 1");
  });
});

test.describe("toolbar Insert menu: styling opt-ins", () => {
  test("divider and date rows show shortcut hints and insert", async ({ page }) => {
    // @feat shortcuts: e2e — Insert menu divider / Today rows render registry hints
    const host = await createPaper(page);
    await gotoPaper(page, host.url);
    const app = page.locator("#app-root");
    await app.locator(".ProseMirror").click();

    const menu = await openInsertMenu(page);
    const row = (label: string) =>
      menu.getByRole("menuitem").filter({
        has: page.locator(".tb-menu-label", { hasText: new RegExp(`^${label}$`) }),
      });
    // Hint glyphs are platform-formatted, so match the key, not the modifier.
    await expect(row("Divider").locator(".tb-menu-hint")).toContainText("_");
    await expect(row("Today").locator(".tb-menu-hint")).toContainText(";");
    await expect(row("Tomorrow").locator(".tb-menu-hint")).toContainText(";");
    await expect(row("Date")).toBeVisible();

    await row("Divider").click();
    await expect(app.locator(".ProseMirror hr")).toHaveCount(1);
  });
});
