import { defineShot } from "../defineShot.mjs";
import { shotUnion } from "../helpers.mjs";

// The "Q3 plan" fixture: struck-through text in a paragraph and a task list,
// with the caret parked inside a struck span so the toolbar's strikethrough
// button renders pressed. Framed from the toolbar down to the task list (the
// editor's min-height would otherwise add a tall empty band).
export default defineShot({
  name: "strikethrough",
  order: 45,
  doc: "strikethroughId",
  prepare: async (page) => {
    const app = page.locator("#app-root");
    await app.locator(".ProseMirror s").first().click();
    await app
      .locator('.paper-toolbar button[aria-label^="Strikethrough"][aria-pressed="true"]')
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) => shotUnion(page, [".paper-toolbar", ".ProseMirror ul[data-task-list]"], file),
});
