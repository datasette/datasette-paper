import { defineShot } from "../defineShot.mjs";

// Auto-generated table-of-contents block: the ```paper-toc card renders a
// nested, clickable outline of the document's headings.
export default defineShot({
  name: "toc",
  order: 31,
  doc: "tocId",
  prepare: async (page) => {
    // The list renders synchronously from the doc (no fetch) — wait for the
    // first generated entry before capturing.
    await page
      .locator(".pm-toc .pm-toc-link")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  },
});
