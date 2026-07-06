import { defineShot } from "../defineShot.mjs";

// The Sources panel (list + add/edit/delete + Test), opened from the right-hand
// icon rail: click the Sources icon, then capture the flyout card.
export default defineShot({
  name: "sources-panel",
  order: 23,
  doc: "inlineValueId",
  prepare: async (page) => {
    await page.locator('.paper-rail-btn[aria-label="Sources"]').click();
    await page.locator(".sources-panel-item").first().waitFor({
      state: "visible",
      timeout: 10_000,
    });
  },
  capture: (page, file) =>
    page.locator(".paper-rail-flyout").screenshot({ path: file }),
});
