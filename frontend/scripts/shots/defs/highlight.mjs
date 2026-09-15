import { defineShot } from "../defineShot.mjs";
import { shotUnion } from "../helpers.mjs";

// The color highlight mark: a paragraph using all four slots, with the
// toolbar's swatch popover open. The caret is parked inside the hl2
// ("launch date is fixed") span first, so the popover shows the active-color
// ring on swatch 2. Own doc (never edited), so order is free. Captured as the
// union of the toolbar + popover and the doc content (through its last
// paragraph, skipping the editor's 60vh min-height blank).
export default defineShot({
  name: "highlight",
  order: 44,
  doc: "highlightId",
  themes: ["light", "dark"],
  prepare: async (page) => {
    const app = page.locator("#app-root");
    const mark = app.locator('.ProseMirror mark.pp-hl[data-color="hl2"]');
    await mark.waitFor({ state: "visible", timeout: 10_000 });
    await mark.click();
    await app.getByLabel("Highlight (⌘⇧H)").click();
    await app
      .locator('.tb-hl-swatch.current[data-color="hl2"]')
      .waitFor({ state: "visible", timeout: 10_000 });
  },
  capture: (page, file) =>
    shotUnion(
      page,
      ["#app-root .paper-toolbar", "#app-root .ProseMirror > p:last-of-type"],
      file,
    ),
});
