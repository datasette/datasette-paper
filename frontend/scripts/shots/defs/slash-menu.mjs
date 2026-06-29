import { defineShot } from "../defineShot.mjs";

// The Notion-style `/` slash command menu, open in an empty block.
export default defineShot({
  name: "slash-menu",
  order: 8,
  doc: "slashId",
  prepare: async (page) => {
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("/");
    await page.locator(".pm-slash-menu").waitFor({ state: "visible", timeout: 10_000 });
  },
});
