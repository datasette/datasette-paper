import { defineShot } from "../defineShot.mjs";
import { PAPER } from "../config.mjs";

// The standalone results page reached by clicking an inline #tag — lists every
// viewable doc whose body contains that tag (here `#roadmap`, seeded into three
// ACTOR-owned docs). Fetched client-side, so wait for the rows to render before
// capturing the framed `.tag-page` column.
export default defineShot({
  name: "tag-page",
  order: 7,
  goto: (page) => page.goto(`${PAPER}/tag/roadmap`),
  prepare: async (page) => {
    await page.locator(".tag-page-list").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelectorAll(".tag-page-row").length >= 3,
      { timeout: 10_000 },
    );
  },
  capture: (page, file) => page.locator(".tag-page").screenshot({ path: file }),
});
