import { defineShot } from "../defineShot.mjs";

// The `${{` autocomplete: type a source name + dot to reach the column stage,
// where the source's columns are offered. Types into the shared inlineValueId
// doc, so it must run after `inline-value` (hence the order).
export default defineShot({
  name: "inline-value-popup",
  order: 21,
  doc: "inlineValueId",
  prepare: async (page) => {
    // Wait for the source to run so its columns are available to the popup.
    await page.waitForFunction(
      () => {
        const p = document.querySelector(".pm-source-card-probe");
        return p && /columns?:/.test(p.textContent || "");
      },
      { timeout: 10_000 },
    );
    await page.locator(".ProseMirror p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" ${{vendors.");
    await page.locator(".pm-value-popup .pm-value-item").first().waitFor({
      state: "visible",
      timeout: 10_000,
    });
  },
});
