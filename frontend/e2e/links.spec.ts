/**
 * E2E for the `[[`-triggered wiki-link autocomplete: typing `[[` plus a
 * query opens a floating result list backed by the link-search API;
 * choosing a result inserts a `paper_link` node whose NodeView resolves
 * the target paper's title.
 */
import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper } from "./helpers";

test.describe("wiki-link autocomplete", () => {
  test("[[ autocomplete inserts a paper_link", async ({ page }) => {
    // A target paper the autocomplete should surface, plus the host doc
    // we'll type into. The e2e webServer grants view/edit globally, so
    // the target is visible to link-search.
    await createPaper(page, { name: "Autocomplete Target ABC" });
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    // Focus the editor and trigger the popup.
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("[[Autocomplete");

    // The popup appears and lists the matching paper.
    const popup = page.locator(".pm-wikilink-popup");
    await expect(popup).toBeVisible({ timeout: 10000 });
    const match = popup.locator(".pm-wikilink-item", {
      hasText: "Autocomplete Target ABC",
    });
    await expect(match).toBeVisible({ timeout: 10000 });

    // Choose the first result and commit.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // A paper_link node is now rendered; its NodeView resolves the title
    // asynchronously, so poll the rendered text.
    const link = page.locator(".pm-paper-link");
    await expect(link).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => link.first().innerText(), {
        timeout: 10000,
        message: "paper_link never resolved its title",
      })
      .toContain("Autocomplete Target ABC");

    // The typed `[[` trigger text is gone.
    await expect(editor).not.toContainText("[[Autocomplete");
  });
});
