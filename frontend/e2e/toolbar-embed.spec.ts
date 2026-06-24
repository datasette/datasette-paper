/**
 * E2E for the toolbar embed dropdown — the third entry point for inserting a
 * Datasette embed (after URL paste and the `/` slash menu).
 *
 * The webServer attaches a `data` database with a `vendors` table (30 rows),
 * so the inserted embed resolves and renders real data — the same fixture
 * `datasette-embeds.spec.ts` uses. With no third-party providers registered
 * (the default install) the toolbar control has a single source, so clicking
 * the trigger opens the native picker dialog directly (no menu). We then assert
 * the same `block_embed` result the slash-menu spec asserts, proving the
 * toolbar reuses the existing picker + insert path.
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
    // embed launcher. One source (no providers) → opens the dialog directly.
    await app.locator(".ProseMirror").click();
    await app.getByLabel("Insert embed").click();

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
