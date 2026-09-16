import { defineShot } from "../defineShot.mjs";
import { shotUnion } from "../helpers.mjs";

// The selection bubble: drag-select a phrase in the rich doc's intro paragraph
// and the docked strip's floating twin appears over it. Framed as the union of
// the strip and that paragraph so both surfaces are in one frame — the point of
// the feature is that they carry the same controls.
//
// Ordering: selecting text doesn't mutate the doc, so this can't disturb the
// shots that capture richId clean (editor 2, tables 25, tasks 26). What it must
// stay ahead of is `wiki-links`, the one shot that *types* into richId — the
// runner sorts by (order, name), and "selection-bubble" < "wiki-links", so
// sharing order 27 puts this first.
export default defineShot({
  name: "selection-bubble",
  order: 27,
  doc: "richId",
  prepare: async (page) => {
    const para = page.locator(".ProseMirror p").first();
    await para.waitFor({ state: "visible", timeout: 10_000 });

    // Drag across the phrase rather than double-clicking a word: `mouseup` is
    // the settle trigger either way, but a multi-word range shows the bubble
    // doing what it's for. The rect comes from a DOM Range so the drag is
    // pinned to the text, not to a guessed offset.
    const PHRASE = "plan the next quarter";
    const rect = await page.evaluate((phrase) => {
      const root = document.querySelector(".ProseMirror");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const i = (node.textContent ?? "").indexOf(phrase);
        if (i === -1) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + phrase.length);
        const rects = range.getClientRects();
        if (rects.length !== 1) throw new Error(`phrase wraps a line: ${phrase}`);
        const r = rects[0];
        return { left: r.left, right: r.right, cy: r.top + r.height / 2 };
      }
      throw new Error(`phrase not found: ${phrase}`);
    }, PHRASE);

    await page.mouse.move(rect.left + 1, rect.cy);
    await page.mouse.down();
    await page.mouse.move(rect.right - 1, rect.cy, { steps: 8 });
    await page.mouse.up();
    await page
      .locator(".pm-selection-bubble")
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) =>
    shotUnion(page, [".paper-toolbar", ".ProseMirror p:first-of-type"], file),
});
