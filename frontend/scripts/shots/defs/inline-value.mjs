import { defineShot } from "../defineShot.mjs";
import { waitInlineValues } from "../helpers.mjs";

// Inline SQL value chips resolved live from a source query.
export default defineShot({
  name: "inline-value",
  order: 20,
  doc: "inlineValueId",
  prepare: waitInlineValues,
});
