import { defineShot } from "../defineShot.mjs";

// The Datasette embed picker dialog (slash command → search → result). "/embed"
// selects "Embed a table" (index 0), which opens the table-filtered picker.
export default defineShot({
  name: "embed-picker",
  order: 9,
  doc: "embedPickerId",
  prepare: async (page) => {
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("/embed");
    await page.locator(".pm-slash-menu").waitFor({ state: "visible", timeout: 10_000 });
    await page.keyboard.press("Enter");
    const dialog = page.locator(".ds-embed-dialog");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.locator(".ds-embed-search").fill("vendors");
    await dialog
      .locator(".ds-embed-result", { hasText: "vendors" })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) => page.locator(".ds-embed-dialog").screenshot({ path: file }),
});
