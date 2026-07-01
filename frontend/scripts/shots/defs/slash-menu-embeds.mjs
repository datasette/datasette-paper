import { defineShot } from "../defineShot.mjs";
import { openFreshSlashMenu, highlightSlashItem } from "../helpers.mjs";

// The `/` slash menu scrolled to its Embeds section — third-party
// `paper_embed_provider` sources (seeded by the throwaway shot-plugin
// embed_provider.py). "Place search" is the last item overall, so highlighting
// it scrolls the popup to the bottom, framing the Embeds section. Shares
// `slashId` with slash-menu / slash-menu-datasette — order 8, clears on open.
export default defineShot({
  name: "slash-menu-embeds",
  order: 8,
  doc: "slashId",
  prepare: async (page) => {
    await openFreshSlashMenu(page);
    await highlightSlashItem(page, "Place search");
  },
  capture: (page, file) => page.locator(".pm-slash-menu").screenshot({ path: file }),
});
