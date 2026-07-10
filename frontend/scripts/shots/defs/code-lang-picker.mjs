import { defineShot } from "../defineShot.mjs";
import { shotUnion } from "../helpers.mjs";

// Corner chrome: hover reveals the language button, opening it shows the
// type-to-filter popup over the language registry. Never selects a row —
// this shot must not mutate the doc `code-block` also captures clean.
export default defineShot({
  name: "code-lang-picker",
  order: 41,
  doc: "codeBlockId",
  prepare: async (page) => {
    const block = page.locator(".pm-code-block");
    await block
      .locator("span.tok-keyword")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await block.hover();
    await block.locator(".pm-code-block-lang-btn").click();
    await page
      .locator(".pm-code-block-lang-popup--open")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".pm-code-block-lang-input").fill("py");
    await page
      .locator(".pm-code-block-lang-item", { hasText: "Python" })
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  // The popup is an absolutely-positioned descendant that overflows below
  // the code block's own box — union the two so the capture isn't clipped
  // (same pattern tableInsertTooltip's floating UI needs).
  capture: (page, file) =>
    shotUnion(page, [".pm-code-block", ".pm-code-block-lang-popup"], file),
});
