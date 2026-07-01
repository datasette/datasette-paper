import { defineShot } from "../defineShot.mjs";

// The source card (named query) that feeds the value chips — element capture.
export default defineShot({
  name: "source-card",
  order: 24,
  doc: "inlineValueId",
  prepare: async (page) => {
    await page.locator(".pm-source-card").waitFor({ state: "visible", timeout: 10_000 });
    // The card renders as a collapsed pill by default; expand it so the shot
    // shows the full SQL editor + probe.
    await page.locator(".pm-source-card-toggle").click();
    await page.waitForFunction(
      () => {
        const p = document.querySelector(".pm-source-card-probe");
        return p && p.textContent && p.textContent !== "running…";
      },
      { timeout: 10_000 },
    );
  },
  capture: (page, file) => page.locator(".pm-source-card").screenshot({ path: file }),
});
