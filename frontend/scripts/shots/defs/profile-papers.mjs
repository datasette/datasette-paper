import { defineShot } from "../defineShot.mjs";
import { BASE } from "../config.mjs";

// The "Papers" section datasette-paper contributes to a datasette-user-profiles
// profile page via the `datasette_user_profile_sections` hook. Visiting bob's
// profile (as the context viewer, alice) renders the host page's heading plus
// paper's `<profile-papers>` element, which fetches
// `/-/paper/api/profile/bob/docs` and lists bob's created / recently-edited
// papers — badged Created / "Created · edited" with a relative time. Seeded so
// bob owns "Product Roadmap" (also edited by bob → "Created · edited") and
// "Budget 2026" ("Created"). Independent page, so `order` is unconstrained.
export default defineShot({
  name: "profile-papers",
  order: 30,
  goto: (page, { ids }) => page.goto(`${BASE}/-/profile/${ids.profileActor}`),
  prepare: async (page) => {
    // Host-page contract: the "Papers" section heading is always present.
    const section = page.locator(".profile-section", { hasText: "Papers" });
    await section.locator("h2").waitFor({ state: "visible", timeout: 15_000 });
    // Wait for the async fetch to render the seeded rows (loading → list).
    const papers = page.locator("profile-papers");
    await papers
      .locator(".paper-profile-item", { hasText: "Product Roadmap" })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelectorAll("profile-papers .paper-profile-item").length >= 2,
      { timeout: 10_000 },
    );
  },
});
