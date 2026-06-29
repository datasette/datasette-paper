import { defineShot } from "../defineShot.mjs";

// The create-page dialog, opened from the `[[`-autocomplete's "Create … page"
// row and prefilled with the typed title. Types into the shared richId doc, so
// it runs after the clean richId shots (editor, tables, tasks). No freeze — the
// dialog carries no volatile text. The capture only frames the dialog, so the
// `[[` text left in the doc underneath doesn't show.
export default defineShot({
  name: "create-page-dialog",
  order: 28,
  doc: "richId",
  freeze: false,
  prepare: async (page) => {
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" [[Release Notes");
    const createRow = page.locator(".pm-wikilink-create");
    await createRow.waitFor({ state: "visible", timeout: 10_000 });
    await createRow.click();
    await page
      .locator("dialog.create-page-dialog")
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) =>
    page.locator("dialog.create-page-dialog").screenshot({ path: file }),
});
