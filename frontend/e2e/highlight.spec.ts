/**
 * E2E for the color highlight mark: select a word, open the toolbar swatch
 * popover, pick color 2, and assert the rendered `<mark>` has a real
 * (non-transparent) background; reload to prove it persisted through the
 * step log (and round-trips as `<mark data-color="hl2">` markdown); then
 * "Remove highlight" drops the mark.
 *
 * Locators are scoped to `#app-root` — the debug-bar injects an "act as"
 * <select> outside it.
 */
import { test, expect, type Page } from "@playwright/test";
import { createPaper, gotoPaper, typeInEditor } from "./helpers";

const BASE = `/-/paper`;

async function documentMarkdown(page: Page, id: number): Promise<string> {
  const r = await page.request.get(`${BASE}/api/docs/${id}/document`);
  if (!r.ok()) return "";
  return (await r.json()).content_markdown as string;
}

test.describe("highlight mark", () => {
  test("pick a color from the toolbar popover, persist across reload, then remove", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);
    const app = page.locator("#app-root");

    await typeInEditor(page, "hello world");
    await expect
      .poll(() => documentMarkdown(page, host.id), { timeout: 10000 })
      .toContain("hello world");

    // Select "world".
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");

    await app.getByLabel("Highlight (⌘⇧H)").click();
    await app.getByLabel("Highlight color 2").click();
    await expect(app.locator(".tb-hl-menu")).toHaveCount(0);

    const mark = app.locator('.ProseMirror mark.pp-hl[data-color="hl2"]');
    await expect(mark).toHaveText("world");
    const bg = await mark.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");

    await expect
      .poll(() => documentMarkdown(page, host.id), {
        timeout: 10000,
        message: "highlight never persisted",
      })
      .toContain('hello <mark data-color="hl2">world</mark>');

    await page.reload();
    await expect(app.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true", {
      timeout: 10000,
    });
    await expect(mark).toHaveText("world");

    // Select the highlighted word again (model selection over "world",
    // positions 7..12 in the lone paragraph) and remove the highlight.
    await mark.click();
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (window as any).__pmView;
      const { doc, tr } = view.state;
      const Sel = view.state.selection.constructor;
      view.dispatch(tr.setSelection(Sel.create(doc, 7, 12)));
    });
    await app.getByLabel("Highlight (⌘⇧H)").click();
    await app.getByLabel("Remove highlight").click();
    await expect(app.locator(".ProseMirror mark.pp-hl")).toHaveCount(0);
    await expect
      .poll(() => documentMarkdown(page, host.id), { timeout: 10000 })
      .not.toContain("<mark");
  });
});
