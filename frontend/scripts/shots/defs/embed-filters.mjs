import { defineShot } from "../defineShot.mjs";
import { waitBlockEmbed } from "../helpers.mjs";

// Block `block_embed` with a shared filter + sort (`config.filters` /
// `config.sort`): funnel badge, "N rows where … sorted by …" summary line,
// and the ▼ indicator on the sorted column.
export default defineShot({
  name: "embed-filters",
  order: 17,
  doc: "blockFiltersId",
  prepare: (page) => waitBlockEmbed(page, "Vendor 8"),
});
