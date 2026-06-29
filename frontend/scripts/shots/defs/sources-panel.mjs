import { defineShot } from "../defineShot.mjs";

// The doc-level Sources panel (list + add/edit/delete + Test).
export default defineShot({
  name: "sources-panel",
  order: 23,
  doc: "inlineValueId",
  prepare: async (page) => {
    const toggle = page.locator(".sources-panel-toggle");
    await toggle.waitFor({ state: "visible", timeout: 10_000 });
    await toggle.click();
    await page.locator(".sources-panel-item").first().waitFor({
      state: "visible",
      timeout: 10_000,
    });
  },
  capture: (page, file) => page.locator(".sources-panel").screenshot({ path: file }),
});
