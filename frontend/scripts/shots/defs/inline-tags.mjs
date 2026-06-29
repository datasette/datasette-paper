import { defineShot } from "../defineShot.mjs";

// Inline `#tags` rendered in the body. Wait for the pills to render.
export default defineShot({
  name: "inline-tags",
  order: 5,
  doc: "inlineTagId",
  prepare: async (page) => {
    await page.waitForFunction(
      () => document.querySelectorAll(".pm-tag").length >= 3,
      { timeout: 10_000 },
    );
  },
});
