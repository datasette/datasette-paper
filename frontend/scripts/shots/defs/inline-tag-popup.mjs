import { defineShot } from "../defineShot.mjs";

// The `#` suggest popup. Types into the shared inlineTagId doc, so it must run
// after `inline-tags` (which screenshots that doc clean) — hence the order.
export default defineShot({
  name: "inline-tag-popup",
  order: 6,
  doc: "inlineTagId",
  prepare: async (page) => {
    // Land the cursor at the end of the intro paragraph, then trigger the
    // `#` suggest popup with a partial query.
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" #road");
    await page.locator(".pm-tag-popup").waitFor({ state: "visible", timeout: 10_000 });
  },
});
