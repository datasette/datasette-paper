/**
 * E2E for the grouped `/` slash menu (section headers — Option A).
 *
 * Covers:
 *   - typing `/` shows non-interactive `.pm-slash-header` section labels
 *     ("Styling", "Media", "Datasette") in display order
 *   - keyboard nav (ArrowDown/Enter) skips headers and inserts the
 *     highlighted *item* (not a header)
 *   - headers stay while searching ("keep grouped" behavior, ticket 06):
 *     typing `/head` keeps the Styling header above the heading commands
 *
 * Locators are scoped to `#app-root` per the debug-bar "act as" gotcha.
 */
import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper } from "./helpers";

test.describe("slash menu sections", () => {
  test("headers render, nav skips them, and search keeps grouping", async ({ page }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const editor = app.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("/");

    const menu = app.locator(".pm-slash-menu");
    await expect(menu).toBeVisible({ timeout: 10000 });

    // Section headers are present, in display order. (Embeds only appears
    // when a 3rd-party provider is registered; the core e2e build has none,
    // so we assert the always-present three.)
    const headers = menu.locator(".pm-slash-header");
    await expect(headers.nth(0)).toHaveText("Styling");
    await expect(headers.nth(1)).toHaveText("Media");
    await expect(headers.nth(2)).toHaveText("Datasette");

    // The first item (Heading 1) is highlighted; headers never get --active.
    await expect(menu.locator(".pm-slash-item").first()).toHaveClass(
      /pm-slash-item--active/,
    );
    await expect(menu.locator(".pm-slash-header.pm-slash-item--active")).toHaveCount(0);

    // ArrowDown moves the highlight item-to-item (skips headers): pressing it
    // once lands on the second item, never on a header row.
    await page.keyboard.press("ArrowDown");
    const items = menu.locator(".pm-slash-item");
    await expect(items.nth(1)).toHaveClass(/pm-slash-item--active/);

    // Enter inserts the highlighted item (Heading 2), not a header.
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(app.locator(".ProseMirror h2")).toBeVisible({ timeout: 10000 });

    // --- search keeps grouping: `/head` still shows the Styling header. ---
    await editor.click();
    // New empty paragraph after the heading; type the trigger there.
    await page.keyboard.press("Enter");
    await page.keyboard.type("/head");
    await expect(menu).toBeVisible({ timeout: 10000 });
    await expect(menu.locator(".pm-slash-header", { hasText: "Styling" })).toBeVisible();
    // All matches (Heading 1/2/3) are styling items under that one header.
    await expect(menu.locator(".pm-slash-item")).toHaveCount(3);
    await page.keyboard.press("Escape");
  });
});
