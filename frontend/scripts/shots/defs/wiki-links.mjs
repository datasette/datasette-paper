import { defineShot } from "../defineShot.mjs";

// The `[[` wiki-link autocomplete. Types into the shared richId doc, so it must
// run after every shot that screenshots that doc clean (editor, tables, tasks)
// — hence the order.
export default defineShot({
  name: "wiki-links",
  order: 27,
  doc: "richId",
  prepare: async (page) => {
    // Land the cursor at the end of the intro paragraph so the `[[` popup opens
    // in clean space (clicking the editor root drops it at doc start, on the H1).
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" [[Des");
    await page.locator(".pm-wikilink-popup").waitFor({ state: "visible", timeout: 10_000 });
    await page
      .locator(".pm-wikilink-item", { hasText: "Design Notes" })
      .first()
      .waitFor({ timeout: 10_000 });
  },
});
