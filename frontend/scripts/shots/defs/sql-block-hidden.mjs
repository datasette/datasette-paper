import { defineShot } from "../defineShot.mjs";
import { waitSqlBlock } from "../helpers.mjs";

// SQL query block, collapsed ("Show SQL") report view.
export default defineShot({
  name: "sql-block-hidden",
  order: 19,
  doc: "sqlBlockHiddenId",
  prepare: waitSqlBlock,
});
