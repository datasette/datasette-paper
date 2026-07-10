import { defineShot } from "../defineShot.mjs";

// A python code block, unfocused: the static (tier-0) lezer highlight is
// what viewers and unfocused editors see — no CodeMirror mounted.
export default defineShot({
  name: "code-block",
  order: 40,
  doc: "codeBlockId",
  prepare: async (page) => {
    await page
      .locator(".pm-code-block span.tok-keyword")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  themes: ["light", "dark"],
});
