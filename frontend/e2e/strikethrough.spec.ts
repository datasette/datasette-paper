/**
 * E2E for the `strike` inline mark. Locators are scoped to `#app-root` (the
 * debug-bar "act as" <select> gotcha — see e2e/CLAUDE.md).
 *
 * Covers: select a word, click the toolbar strikethrough button → the word
 * renders in `<s>` and the button reads pressed; after reload the mark is
 * still there (persisted through the step log) and `/document` serializes it
 * as `~~word~~`.
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoPaper, readEditorState } from "./helpers";

const BASE = `/-/paper`;

async function createSeededPaper(
  page: Page,
  content: string,
): Promise<{ id: number; url: string }> {
  const name = `Strike-E2E-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await page.request.post(`${BASE}/api/docs`, { data: { name, content } });
  expect(r.status()).toBe(201);
  const body = await r.json();
  return { id: body.id, url: `${BASE}/doc/${body.id}` };
}

/** Select the doc text range [from, to) inside the first paragraph. */
async function selectRange(page: Page, from: number, to: number) {
  await page.evaluate(
    ([a, b]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (window as unknown as { __pmView: any }).__pmView;
      const Sel = view.state.selection.constructor;
      view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, a, b)));
      view.focus();
    },
    [from, to],
  );
}

// @feat strikethrough: e2e — toolbar button strikes a selected word, pressed state, persists across reload
test("toolbar strikethrough button strikes the selection and it persists", async ({ page }) => {
  const doc = await createSeededPaper(page, "alpha beta gamma\n");
  await gotoPaper(page, doc.url);

  const app = page.locator("#app-root");
  const editor = app.locator(".ProseMirror");
  const button = app.locator('.paper-toolbar button[aria-label^="Strikethrough"]');

  await editor.click();
  // "beta" sits at doc positions 7..11 (paragraph content starts at 1).
  await selectRange(page, 7, 11);
  await button.click();

  await expect(editor.locator("s")).toHaveText("beta");
  await expect(button).toHaveAttribute("aria-pressed", "true");

  // Wait for the step to land server-side before reloading (reload aborts
  // in-flight POST batches).
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`${BASE}/api/docs/${doc.id}/document`);
        if (!r.ok()) return "";
        return (await r.json()).content_markdown as string;
      },
      { timeout: 10_000 },
    )
    .toContain("~~beta~~");

  await page.reload();
  await expect(app.locator(".ProseMirror")).toBeVisible();
  await expect(app.locator(".ProseMirror s")).toHaveText("beta");
  const state = await readEditorState(page);
  expect(JSON.stringify(state.doc)).toContain('"type":"strike"');
});
