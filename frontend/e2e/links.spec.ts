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

    // The first result is highlighted by default; commit it. (ArrowDown
    // would now move onto the trailing "Create … page" row.)
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

  test("[[ create row mints a new page and links it", async ({ page }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const editor = page.locator(".ProseMirror");
    await editor.click();
    // A title that matches nothing existing, so the create row is the
    // only actionable option.
    await page.keyboard.type("[[Fresh Page XYZ");

    const popup = page.locator(".pm-wikilink-popup");
    await expect(popup).toBeVisible({ timeout: 10000 });
    const createRow = popup.locator(".pm-wikilink-create");
    await expect(createRow).toBeVisible({ timeout: 10000 });
    await expect(createRow).toContainText("Fresh Page XYZ");

    // Open the create dialog (prefilled with the typed title) and confirm.
    await createRow.click();
    const dialog = page.locator(".create-page-dialog");
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(dialog.locator("input")).toHaveValue("Fresh Page XYZ");
    await dialog.locator(".create-page-create-btn").click();

    // The brand-new doc's paper_link is inserted and resolves to its title.
    const link = page.locator(".pm-paper-link");
    await expect(link).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => link.first().innerText(), {
        timeout: 10000,
        message: "new paper_link never resolved its title",
      })
      .toContain("Fresh Page XYZ");

    // The typed trigger text is gone and the dialog has closed.
    await expect(editor).not.toContainText("[[Fresh");
    await expect(dialog).not.toBeVisible();
  });
});
