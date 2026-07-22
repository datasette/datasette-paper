import { defineShot } from "../defineShot.mjs";

// The insert-image dialog, empty state. No freeze (no volatile text).
export default defineShot({
  name: "image-dialog-empty",
  order: 29,
  doc: "richId",
  freeze: false,
  prepare: async (page) => {
    // Image insert moved behind the toolbar's ＋ Insert menu.
    await page.locator('.paper-toolbar [aria-label="Insert"]').click();
    await page
      .locator('.tb-insert-menu')
      .getByRole("menuitem", { name: "Image", exact: true })
      .click();
    await page.locator("dialog.image-dialog").waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) => page.locator("dialog.image-dialog").screenshot({ path: file }),
});
