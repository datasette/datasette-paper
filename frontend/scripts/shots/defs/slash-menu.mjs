import { defineShot } from "../defineShot.mjs";
import { openFreshSlashMenu } from "../helpers.mjs";

// The Notion-style `/` slash command menu, open in an empty block. Uses
// openFreshSlashMenu (select-all + Backspace before typing "/") rather than a
// bare type: the shot's own dark twin re-runs against the same collab doc, and
// a leftover "/" from the light leg would keep the menu hidden. The clear is a
// no-op on the pristine empty slashId, so the light PNG is byte-identical.
export default defineShot({
  name: "slash-menu",
  order: 8,
  doc: "slashId",
  themes: ["light", "dark"],
  prepare: openFreshSlashMenu,
});
