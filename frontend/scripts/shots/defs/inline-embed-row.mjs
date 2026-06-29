import { defineShot } from "../defineShot.mjs";
import { waitInlineEmbed } from "../helpers.mjs";

// Inline `inline_embed` pill resolving a single row.
export default defineShot({
  name: "inline-embed-row",
  order: 12,
  doc: "inlineRowId",
  prepare: waitInlineEmbed,
});
