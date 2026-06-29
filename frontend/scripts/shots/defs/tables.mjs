import { defineShot } from "../defineShot.mjs";
import { shotUnion } from "../helpers.mjs";

// The in-table floating action bar. The bar lives in a body-appended root, so
// capture the bounding-box union of it + the table (an element clip would lose
// the detached bar).
export default defineShot({
  name: "tables",
  order: 25,
  doc: "richId",
  prepare: async (page) => {
    // Click a data cell to summon the floating in-table action bar.
    const table = page.locator(".ProseMirror table");
    await table.scrollIntoViewIfNeeded();
    await page.locator(".ProseMirror table td").first().click();
    await page.locator(".pm-tt-bar").waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) =>
    shotUnion(page, [".pm-table-tooltip-root", ".ProseMirror table"], file),
});
