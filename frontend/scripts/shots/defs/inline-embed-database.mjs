import { defineShot } from "../defineShot.mjs";
import { waitInlineEmbed } from "../helpers.mjs";

// Inline `inline_embed` pill resolving a whole database.
export default defineShot({
  name: "inline-embed-database",
  order: 10,
  doc: "inlineDbId",
  prepare: waitInlineEmbed,
});
