import { defineShot } from "../defineShot.mjs";
import { waitBlockEmbed, waitSqlBlock } from "../helpers.mjs";

// Result rendering on ugly data: a wide (13-column) table embed and a SQL
// block over the same rows. Long/multi-line values collapse to one clamped
// ellipsized line, blob cells render as their byte size, and the table
// h-scrolls with the right-edge fade signalling more columns.
export default defineShot({
  name: "result-rendering",
  order: 18,
  doc: "resultRenderingId",
  prepare: async (page) => {
    await waitBlockEmbed(page, "Checkout button unresponsive");
    await waitSqlBlock(page);
  },
});
