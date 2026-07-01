import { defineShot } from "../defineShot.mjs";

// The authors byline in the sidebar, manager view (the shots browser is ACTOR,
// who owns the doc → canManage). Shows the credited co-authors plus the
// add/reorder/remove affordances. No volatile text in the panel, so freeze off.
export default defineShot({
  name: "authors",
  order: 9,
  doc: "authorsId",
  freeze: false,
  prepare: async (page) => {
    await page
      .locator("#app-root .authors-panel")
      .getByText("Carol Shaw")
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) =>
    page.locator("#app-root .authors-panel").screenshot({ path: file }),
});
