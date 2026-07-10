import { defineShot } from "../defineShot.mjs";

// The `[[` wiki-link autocomplete. Types into the shared richId doc, so it must
// run after every shot that screenshots that doc clean (editor, tables, tasks)
// — hence the order.
export default defineShot({
  name: "wiki-links",
  order: 27,
  doc: "richId",
  themes: ["light", "dark"],
  prepare: async (page) => {
    // Land the cursor at the end of the intro paragraph so the `[[` popup opens
    // in clean space (clicking the editor root drops it at doc start, on the H1).
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.press("End");
    // This shot's own dark twin re-runs against the same collab doc, so the
    // light leg's typed " [[Des" is still there (it lands in the H1 title, where
    // click + End actually leaves the cursor). Strip a trailing wiki token from
    // whichever block now holds the cursor so the dark leg starts clean; the
    // regex can't match a pristine title (no "[["), so it deletes 0 chars on the
    // light leg → byte-identical PNG.
    const stale = await page.evaluate(() => {
      const sel = window.getSelection();
      let block = sel?.anchorNode ?? null;
      if (block && block.nodeType === 3) block = block.parentElement;
      while (block?.parentElement && !block.parentElement.classList.contains("ProseMirror")) {
        block = block.parentElement;
      }
      const m = (block?.textContent ?? "").match(/\s*\[\[[^[\]]*$/);
      return m ? m[0].length : 0;
    });
    for (let i = 0; i < stale; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type(" [[Des");
    await page.locator(".pm-wikilink-popup").waitFor({ state: "visible", timeout: 10_000 });
    await page
      .locator(".pm-wikilink-item", { hasText: "Design Notes" })
      .first()
      .waitFor({ timeout: 10_000 });
  },
});
