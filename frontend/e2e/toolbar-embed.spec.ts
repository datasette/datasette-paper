/**
 * E2E for the toolbar embed dropdown — the third entry point for inserting a
 * Datasette embed (after URL paste and the `/` slash menu).
 *
 * The webServer attaches a `data` database with a `vendors` table (30 rows),
 * so the inserted embed resolves and renders real data — the same fixture
 * `datasette-embeds.spec.ts` uses. The e2e webServer loads the sample plugin
 * (`--plugins-dir ../tests/sample-plugin`), which registers extra embed
 * providers, so the toolbar control has multiple sources: clicking the trigger
 * opens the dropdown menu, and we then click the native "Datasette embed" item
 * to open the picker dialog. We assert the same `block_embed` result the
 * slash-menu spec asserts, proving the toolbar reuses the existing picker +
 * insert path.
 *
 * Locators are scoped to `#app-root` — the debug-bar injects an "act as"
 * <select> outside it (see the e2e-baseline notes).
 */
import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper } from "./helpers";

test.describe("toolbar embed dropdown", () => {
  test("toolbar control opens the picker and inserts a Datasette embed", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");

    // Focus the editor so the edit-mode toolbar is mounted, then click the
    // embed launcher. The sample plugin registers extra providers, so multiple
    // sources → the trigger opens the dropdown menu rather than the dialog.
    await app.locator(".ProseMirror").click();
    await app.getByLabel("Insert embed").click();

    // Pick the native source from the menu to open the picker dialog.
    const menu = app.locator(".tb-embed-menu");
    await expect(menu).toBeVisible({ timeout: 10000 });
    await menu.locator(".tb-embed-item", { hasText: "Datasette embed" }).click();

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
