import { defineShot } from "../defineShot.mjs";
import { gotoEditor } from "../helpers.mjs";

// The per-chip format picker: clicking a date chip opens a popup with a
// natural-language input, a live preview, and a labelled radio list of strftime
// presets (each showing its own rendered example) plus a custom-pattern field.
// Opens the prose chip (neutral) for clean framing. Clock frozen so the
// "Default" preset's example ("Jul 20") omits the year deterministically. Runs
// AFTER `date` (shares the same seeded doc); opening the popup doesn't mutate it.
export default defineShot({
  name: "date-format-picker",
  order: 28,
  goto: async (page, { ids }) => {
    await page.clock.setFixedTime(new Date("2026-07-15T12:00:00"));
    await gotoEditor(page, ids.dateId);
  },
  prepare: async (page) => {
    await page.locator("#app-root .pm-date").first().click();
    const popup = page.locator("#app-root .pm-date-popup");
    await popup.waitFor({ state: "visible", timeout: 10_000 });
    await popup
      .locator(".pm-date-format")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) =>
    page.locator("#app-root .pm-date-popup").screenshot({ path: file }),
});
