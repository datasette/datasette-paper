import { defineShot } from "../defineShot.mjs";
import { waitBlockEmbed } from "../helpers.mjs";

// Block `block_embed` with a column selection (config.columns hides the PK).
export default defineShot({
  name: "block-embed-columns",
  order: 16,
  doc: "blockColumnsId",
  prepare: (page) => waitBlockEmbed(page, "Vendor 1"),
});
