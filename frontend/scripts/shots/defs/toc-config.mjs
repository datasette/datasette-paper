import { defineShot } from "../defineShot.mjs";

// The TOC block's ⋮ options menu open: From/To heading levels + the Numbered
// toggle that write the toc node's `config`.
export default defineShot({
  name: "toc-config",
  order: 32,
  doc: "tocId",
  prepare: async (page) => {
    const toc = page.locator(".pm-toc");
    await toc.locator(".pm-toc-link").first().waitFor({ state: "visible", timeout: 10_000 });
    await toc.locator(".pm-toc-menu-btn").click();
    await toc.locator(".pm-toc-menu--open").waitFor({ state: "visible", timeout: 10_000 });
  },
});
