import { defineShot } from "../defineShot.mjs";
import { waitBlockEmbed } from "../helpers.mjs";

// Block `block_embed` rendering a single row's field card.
export default defineShot({
  name: "block-embed-row",
  order: 15,
  doc: "blockRowId",
  prepare: (page) => waitBlockEmbed(page, "Vendor 5"),
});
