import { defineShot } from "../defineShot.mjs";

// The owner-only tag editor modal, opened from a doc's row action menu.
export default defineShot({
  name: "tag-editor",
  order: 3,
  prepare: async (page) => {
    await page.locator(".paper-index table tbody tr").first().waitFor({ timeout: 15_000 });
    const row = page.locator(".paper-index tbody tr", { hasText: "Q3 Planning" }).first();
    await row.locator('[aria-label="Actions"]').click();
    await page.locator("button", { hasText: "Edit tags" }).first().click();
    await page.locator(".tag-editor").waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) => page.locator(".tag-editor").screenshot({ path: file }),
});
