import { defineShot } from "../defineShot.mjs";
import { shotUnion } from "../helpers.mjs";

// The link hover affordance + Edit dialog. Opens the dedicated linkId doc,
// hovers the inline link to surface the tooltip, then clicks Edit to swap in
// the Text/URL dialog. Its own doc (not shared/mutated), so order is free.
// Captured as the union of the link and the detached dialog (which is appended
// to .editor-host, so an element shot of the dialog alone would lose context).
export default defineShot({
  name: "link-edit",
  order: 23,
  doc: "linkId",
  themes: ["light", "dark"],
  prepare: async (page) => {
    const link = page.locator('.ProseMirror a[href^="https://datasette.io"]');
    await link.waitFor({ state: "visible", timeout: 10_000 });
    // Hover surfaces the tooltip bar; click its Edit button to open the dialog.
    await link.hover();
    const edit = page.locator(".pm-link-tooltip-edit");
    await edit.waitFor({ state: "visible", timeout: 10_000 });
    await edit.click();
    await page
      .locator(".pm-link-edit-dialog")
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) =>
    shotUnion(
      page,
      ['.ProseMirror a[href^="https://datasette.io"]', ".pm-link-edit-dialog"],
      file,
    ),
});
