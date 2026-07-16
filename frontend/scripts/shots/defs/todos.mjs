import { defineShot } from "../defineShot.mjs";
import { PAPER } from "../config.mjs";

// The dedicated /-/paper/todos page: one actor's assigned tasks across every doc
// they can see, bucketed by due date in the viewer's timezone. Browsing as the
// context actor (alice), so it renders "Your TODOs" with all five buckets
// (Overdue / Today / This week / Later / No due date) from the seeded Launch
// checklist. The clock is frozen to 2026-07-15 (setFixedTime keeps timers
// running, so the ActorResolver still flushes) — the seeded due dates sit around
// that day, so the buckets + overdue/today tints are deterministic across runs.
export default defineShot({
  name: "todos",
  order: 32,
  themes: ["light", "dark"],
  goto: async (page) => {
    await page.clock.setFixedTime(new Date("2026-07-15T12:00:00"));
    await page.goto(`${PAPER}/todos`);
  },
  prepare: async (page) => {
    await page
      .locator("#app-root .todos-bucket")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    // All five buckets rendered (rows fetched + bucketed client-side).
    await page.waitForFunction(
      () => document.querySelectorAll("#app-root .todos-bucket").length >= 5,
      { timeout: 10_000 },
    );
    // The multi-assignee row's chips resolved to display names (not bare ids).
    await page.waitForFunction(
      () => {
        const chips = document.querySelectorAll("#app-root .todos-assignee");
        return (
          chips.length > 0 &&
          [...chips].some((c) => /Ada|Babbage/.test(c.textContent || ""))
        );
      },
      { timeout: 10_000 },
    );
  },
});
