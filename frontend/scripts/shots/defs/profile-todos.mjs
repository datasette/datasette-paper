import { defineShot } from "../defineShot.mjs";
import { BASE } from "../config.mjs";

// The `<profile-todos>` section datasette-paper contributes to a
// datasette-user-profiles profile page (a sibling of `<profile-papers>` from the
// same bundle). Visiting bob's profile — the one actor with a seeded profile —
// renders the host heading plus paper's element, which fetches
// `/-/paper/api/profile/bob/todos?status=open` and lists bob's open assigned
// tasks (capped) with an "All TODOs →" footer. Clock frozen to 2026-07-15 so the
// due-chip tints are deterministic. Element capture of the whole section.
export default defineShot({
  name: "profile-todos",
  order: 33,
  goto: async (page) => {
    await page.clock.setFixedTime(new Date("2026-07-15T12:00:00"));
    await page.goto(`${BASE}/-/profile/bob`);
  },
  prepare: async (page) => {
    const section = page.locator(".profile-section", { hasText: "TODOs" });
    await section.locator("h2").waitFor({ state: "visible", timeout: 15_000 });
    await page
      .locator("profile-todos .paper-todos-item")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    // Footer link present → the list has settled.
    await page
      .locator("profile-todos .paper-todos-more")
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) =>
    page
      .locator(".profile-section", { hasText: "TODOs" })
      .screenshot({ path: file }),
});
