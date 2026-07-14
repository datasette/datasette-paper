import { defineShot } from "../defineShot.mjs";
import { stubRandom } from "../helpers.mjs";

// The link-graph modal on the index: the full viewable graph over the seeded
// wiki-link cluster, recolored by tag (populates the legend) with the hub node
// selected so the metadata panel is filled in. Two determinism levers, both
// applied before the modal opens (which is what mounts <LinkGraph>):
// reduced-motion emulation makes the sim take its synchronous fixed-tick
// settle instead of the animated rAF loop, and stubRandom pins the
// seedPositions jitter so the settled layout is identical every run.
//
// Residual: a ResizeObserver-vs-settle timing race can shift the equilibrium
// by a subpixel epsilon, so a re-run may churn a few thousand sub-perceptual
// pixels (max channel delta ~4) on the node circles — same class as the other
// known flaky defs; don't chase it as a regression.
export default defineShot({
  name: "link-graph",
  order: 28,
  themes: ["light", "dark"],
  prepare: async (page) => {
    // Must be set before the modal opens — LinkGraph reads matchMedia at init.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await stubRandom(page);
    await page.locator("#app-root .graph-toggle").click();
    const dialog = page.locator('[role="dialog"][aria-label="Link graph"]');
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog
      .locator(".link-graph-nodes a")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    // Recolor by tag so the legend shows the seeded vocabulary's swatches.
    await dialog
      .locator('select[aria-label="Color nodes by"]')
      .selectOption("tag");
    // Select the hub node (click = select; the circle's bbox centre is the
    // node centre, so we can't fat-finger a neighbour via the label text).
    await dialog
      .locator(".link-graph-nodes a", { hasText: "Team wiki" })
      .locator("circle")
      .last()
      .click();
    await dialog
      .locator(".link-graph-panel-title")
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) => page.locator(".graph-dialog").screenshot({ path: file }),
});
