import { defineShot } from "../defineShot.mjs";
import { openFreshSlashMenu, highlightSlashItem } from "../helpers.mjs";

// The `/` slash menu scrolled to its Datasette section: SQL query, the two
// native embed commands (Embed a table / Embed a database), Inline value, and
// Data source. Highlighting the section's last item ("Data source") frames the
// whole section at the bottom of the popup; we capture the menu element. Shares
// `slashId` with slash-menu / slash-menu-embeds — order 8, clears on open.
export default defineShot({
  name: "slash-menu-datasette",
  order: 8,
  doc: "slashId",
  prepare: async (page) => {
    await openFreshSlashMenu(page);
    await highlightSlashItem(page, "Data source");
  },
  capture: (page, file) => page.locator(".pm-slash-menu").screenshot({ path: file }),
});
