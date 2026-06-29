import { defineShot } from "../defineShot.mjs";
import { waitBlockEmbed } from "../helpers.mjs";

// The "Columns…" picker open in the ⋮ menu: a checklist of every column, with
// the currently-selected ones (name + region) checked and the hidden PK (id)
// unchecked — the author UI that writes config.columns.
export default defineShot({
  name: "block-embed-columns-picker",
  order: 17,
  doc: "blockColumnsId",
  prepare: async (page) => {
    await waitBlockEmbed(page, "Vendor 1");
    const embed = page.locator(".pm-block-embed");
    // Open the ⋮ menu, then swap its body for the column checklist.
    await embed.locator(".pm-block-embed-menu-btn").click();
    await embed
      .locator(".pm-block-embed-menu-item", { hasText: "Columns…" })
      .click();
    await embed
      .locator(".pm-block-embed-columns")
      .waitFor({ state: "visible", timeout: 10_000 });
  },
});
