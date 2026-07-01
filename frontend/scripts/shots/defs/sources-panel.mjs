import { defineShot } from "../defineShot.mjs";

// The Sources panel in the right sidebar (list + add/edit/delete + Test).
// It starts expanded in the rail, so no toggle click is needed.
export default defineShot({
  name: "sources-panel",
  order: 23,
  doc: "inlineValueId",
  prepare: async (page) => {
    await page.locator(".sources-panel-item").first().waitFor({
      state: "visible",
      timeout: 10_000,
    });
  },
  capture: (page, file) => page.locator(".paper-sidebar").screenshot({ path: file }),
});
