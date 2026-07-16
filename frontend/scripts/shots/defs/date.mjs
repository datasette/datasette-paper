import { defineShot } from "../defineShot.mjs";
import { gotoEditor } from "../helpers.mjs";

// The inline `date` atom: compact calendar chips in prose (neutral) and inside
// task items, where an UNCHECKED task's date tints overdue (red) / today
// (amber) and a checked one goes neutral. The clock is frozen to 2026-07-15
// (setFixedTime keeps timers running) so the seeded deadlines render a
// deterministic overdue / today / done trio. Element capture of the editable
// surface frames the prose date plus the deadline list.
export default defineShot({
  name: "date",
  order: 27,
  themes: ["light", "dark"],
  goto: async (page, { ids }) => {
    await page.clock.setFixedTime(new Date("2026-07-15T12:00:00"));
    await gotoEditor(page, ids.dateId);
  },
  prepare: async (page) => {
    await page
      .locator("#app-root .pm-date")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    // The overdue/today decorations settle after the first transaction.
    await page
      .locator("#app-root .pm-date.pp-date-overdue")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) =>
    page.locator("#app-root .ProseMirror").screenshot({ path: file }),
});
