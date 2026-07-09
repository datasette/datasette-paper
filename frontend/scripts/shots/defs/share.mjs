import { defineShot } from "../defineShot.mjs";

// The datasette-acl share dialog (manager view on an owned doc). No freeze —
// the dialog carries no volatile text.
export default defineShot({
  name: "share",
  order: 28,
  doc: "richId",
  freeze: false,
  themes: ["light", "dark"],
  prepare: async (page) => {
    await page.locator(".datasette-acl-share__trigger").click();
    const dialog = page.locator("dialog.datasette-acl-share-dialog[open]");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    // Let the role rows render before capturing.
    await page.locator(".datasette-acl-share-dialog__list").waitFor({ timeout: 10_000 });
  },
  capture: (page, file) =>
    page.locator("dialog.datasette-acl-share-dialog[open]").screenshot({ path: file }),
});
