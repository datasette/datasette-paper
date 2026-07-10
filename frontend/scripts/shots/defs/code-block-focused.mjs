import { defineShot } from "../defineShot.mjs";

// Clicking into the block upgrades it to a live CodeMirror editor — the
// tier-1 surface (real caret rendering, CM's own theme wired to the same
// --pp-* tokens so the swap is pixel-stable).
export default defineShot({
  name: "code-block-focused",
  order: 42,
  doc: "codeBlockId",
  prepare: async (page) => {
    const block = page.locator(".pm-code-block");
    // Wait for tier-0 static highlighting to settle before clicking: the
    // async decoration pass can reflow the `<pre>` right as Playwright polls
    // its bounding box for click stability (force sidesteps it regardless).
    await block
      .locator("span.tok-keyword")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await block.locator("pre").click({ force: true });
    await block.locator(".cm-editor").waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) => page.locator(".pm-code-block").screenshot({ path: file }),
});
