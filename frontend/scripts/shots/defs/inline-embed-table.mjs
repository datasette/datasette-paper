import { defineShot } from "../defineShot.mjs";
import { waitInlineEmbed } from "../helpers.mjs";

// Inline `inline_embed` pill resolving a table.
export default defineShot({
  name: "inline-embed-table",
  order: 11,
  doc: "inlineTableId",
  prepare: waitInlineEmbed,
});
