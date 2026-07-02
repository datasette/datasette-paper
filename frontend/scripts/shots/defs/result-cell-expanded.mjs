import { defineShot } from "../defineShot.mjs";
import { waitBlockEmbed } from "../helpers.mjs";

// A truncated cell expanded in place: the description column's show-full-value
// toggle reveals the multi-line text inside a scrollable cell while the rest
// of the table keeps its one-line clamp. Captures just the embed card.
export default defineShot({
  name: "result-cell-expanded",
  order: 19,
  doc: "resultRenderingId",
  prepare: async (page) => {
    await waitBlockEmbed(page, "Checkout button unresponsive");
    // Expand row 1's description cell (column 9 — the long multi-line value).
    // Target it precisely: earlier cells may also grow (CSS-overflow) toggles.
    const row = page.locator(".pm-block-embed tbody tr").first();
    await row.locator("td:nth-child(9) .pm-result-cell-expand").click();
    await page
      .locator(".pm-block-embed td.is-expanded")
      .waitFor({ state: "visible", timeout: 5_000 });
  },
  capture: (page, file) =>
    page.locator(".pm-block-embed").screenshot({ path: file }),
});
