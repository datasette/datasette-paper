import { defineShot } from "../defineShot.mjs";
import { stubRandom } from "../helpers.mjs";

// The doc-centred ego view: opened from the sidebar rail on the "Team wiki"
// hub, showing the ringed focus node, its depth-1 neighbourhood, and the
// Depth control the index modal doesn't have. Same determinism levers as
// link-graph (reduced motion → synchronous settle, stubRandom → pinned
// seedPositions jitter), applied before the modal opens.
export default defineShot({
  name: "link-graph-ego",
  order: 29,
  doc: "teamWikiId",
  prepare: async (page) => {
    // Must be set before the modal opens — LinkGraph reads matchMedia at init.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await stubRandom(page);
    await page.locator('.paper-rail-btn[aria-label="View in graph"]').click();
    const dialog = page.locator('[role="dialog"][aria-label="Link graph"]');
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog
      .locator(".link-graph-nodes a circle.focus-ring")
      .waitFor({ state: "visible", timeout: 10_000 });
    // The settled ego layout sprawls a little past the canvas edge; two steps
    // of the graph's own zoom-out control (deterministic, centre-anchored)
    // bring every neighbour into frame.
    await dialog.locator('button[aria-label="Zoom out"]').click();
    await dialog.locator('button[aria-label="Zoom out"]').click();
  },
  capture: (page, file) => page.locator(".graph-dialog").screenshot({ path: file }),
});
