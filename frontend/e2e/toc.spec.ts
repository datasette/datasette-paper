/**
 * E2E for the table-of-contents block.
 *
 * Covers:
 *   - inserting a TOC via the `/toc` slash command
 *   - the TOC lists existing headings, and auto-syncs when a new heading is
 *     added elsewhere (driven by tocPlugin, not the toc node's own update)
 *   - clicking an entry scrolls its heading into view
 *
 * Locators are scoped to `#app-root` per the debug-bar "act as" gotcha.
 */
import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper } from "./helpers";

test.describe("table of contents", () => {
  test("inserts via /toc, auto-syncs, and scrolls on click", async ({ page }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const editor = app.locator(".ProseMirror");
    await editor.click();

    // First heading (markdown input rule: "# " → H1), then a fresh paragraph.
    await page.keyboard.type("# Top");
    await page.keyboard.press("Enter");

    // Insert the TOC via the slash menu.
    await page.keyboard.type("/toc");
    const menu = app.locator(".pm-slash-menu");
    await expect(menu).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();

    const toc = app.locator(".pm-toc");
    await expect(toc).toBeVisible({ timeout: 10000 });
    await expect(toc.locator(".pm-toc-link", { hasText: "Top" })).toBeVisible();

    // Push content down with filler so a heading added at the bottom starts
    // off-screen, then add that heading — the TOC must pick it up live.
    await editor.click();
    await page.keyboard.press("Enter");
    for (let i = 0; i < 40; i++) {
      await page.keyboard.type(`Filler line ${i}`);
      await page.keyboard.press("Enter");
    }
    await page.keyboard.type("## Bottom");
    await page.keyboard.press("Space");

    // Auto-sync: the new heading appears in the TOC without re-inserting it.
    const bottomEntry = toc.locator(".pm-toc-link", { hasText: "Bottom" });
    await expect(bottomEntry).toBeVisible({ timeout: 10000 });

    // Scroll back to the top (typing auto-scrolled to the caret at the bottom)
    // so the Bottom heading starts below the fold.
    await page.evaluate(() => window.scrollTo(0, 0));
    const bottomHeading = editor.locator("h2", { hasText: "Bottom" });
    await expect(bottomHeading).not.toBeInViewport();

    // …and clicking its TOC entry scrolls it into view.
    await bottomEntry.click();
    await expect(bottomHeading).toBeInViewport({ timeout: 10000 });
  });
});
