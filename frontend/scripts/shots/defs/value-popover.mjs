import { defineShot } from "../defineShot.mjs";

// The click-to-edit popover on a value chip (column + format config).
export default defineShot({
  name: "value-popover",
  order: 22,
  doc: "inlineValueId",
  prepare: async (page) => {
    const chip = page.locator(".pm-value").first();
    await chip.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(
      () => {
        const els = document.querySelectorAll(".pm-value");
        return els.length > 0 && ![...els].some((e) => e.classList.contains("pm-value--loading"));
      },
      { timeout: 10_000 },
    );
    await chip.click();
    await page.locator(".pm-value-popover").waitFor({ state: "visible", timeout: 10_000 });
  },
});
