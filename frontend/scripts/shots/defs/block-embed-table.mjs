import { defineShot } from "../defineShot.mjs";
import { waitBlockEmbed } from "../helpers.mjs";

// Block `block_embed` rendering a read-only, row-capped table.
export default defineShot({
  name: "block-embed-table",
  order: 14,
  doc: "blockTableId",
  prepare: (page) => waitBlockEmbed(page, "Vendor 1"),
});
