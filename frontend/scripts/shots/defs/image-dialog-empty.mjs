import { defineShot } from "../defineShot.mjs";

// The insert-image dialog, empty state. No freeze (no volatile text).
export default defineShot({
  name: "image-dialog-empty",
  order: 29,
  doc: "richId",
  freeze: false,
  prepare: async (page) => {
    await page.locator('.paper-toolbar [aria-label="Insert image"]').click();
    await page.locator("dialog.image-dialog").waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) => page.locator("dialog.image-dialog").screenshot({ path: file }),
});
