import { defineShot } from "../defineShot.mjs";
import { waitSqlBlock } from "../helpers.mjs";

// SQL query block: editable query + Run + live results.
export default defineShot({
  name: "sql-block",
  order: 18,
  doc: "sqlBlockId",
  prepare: waitSqlBlock,
  themes: ["light", "dark"],
});
