import { defineShot } from "../defineShot.mjs";

// The task list. Element screenshot auto-scrolls and captures the whole list —
// the task list sits below the fold, so a viewport clip would cut it off.
export default defineShot({
  name: "tasks",
  order: 26,
  doc: "richId",
  prepare: async (page) => {
    await page.locator("ul[data-task-list]").first().waitFor({ timeout: 10_000 });
  },
  capture: (page, file) =>
    page.locator("ul[data-task-list]").first().screenshot({ path: file }),
});
