import { defineShot } from "../defineShot.mjs";
import { waitBlockEmbed } from "../helpers.mjs";

// Block `block_embed` rendering a database's table listing.
export default defineShot({
  name: "block-embed-database",
  order: 13,
  doc: "blockDbId",
  prepare: (page) => waitBlockEmbed(page, "vendors"),
});
