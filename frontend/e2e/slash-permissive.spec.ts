/**
 * E2E for the permissive `/` trigger: fires at any cursor position (after
 * whitespace or at line start), with contextual correctness handled by
 * per-command `enabled()` gates instead of the old empty-top-level-paragraph
 * trigger gate.
 *
 * Covers:
 *   - `/date` mid-sentence: inserts an inline date atom at the caret and the
 *     preceding text survives in the same block (asserted on the doc model)
 *   - `/` inside a task-list item: the popup opens, block inserts (Table) are
 *     hidden, inline atoms (Today) remain
 *
 * Locators are scoped to `#app-root` per the debug-bar "act as" gotcha.
 */
import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper, readEditorState } from "./helpers";

type PMNode = { type: string; text?: string; content?: PMNode[] };

test.describe("permissive slash trigger", () => {
  test("inserts an inline date mid-sentence, preserving preceding text", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const editor = app.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("some text ");
    await page.keyboard.type("/today");

    const menu = app.locator(".pm-slash-menu");
    await expect(menu).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();

    const state = await readEditorState(page);
    const doc = state.doc as PMNode;
    const para = doc.content![0];
    expect(para.type).toBe("paragraph");
    const kids = para.content!;
    // The `/today` query text was cleared; "some text " survives, followed by
    // the inline date atom in the SAME block.
    expect(kids[0]).toMatchObject({ type: "text", text: "some text " });
    expect(kids[1].type).toBe("date");
  });

  test("opens in a task-list item with block inserts hidden", async ({ page }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const editor = app.locator(".ProseMirror");
    const menu = app.locator(".pm-slash-menu");

    // Turn the empty paragraph into a task list, then trigger `/` inside it.
    await editor.click();
    await page.keyboard.type("/todo");
    await expect(menu).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Enter");
    await expect(app.locator(".ProseMirror ul[data-task-list]")).toBeVisible({
      timeout: 10000,
    });

    await page.keyboard.type("/");
    await expect(menu).toBeVisible({ timeout: 10000 });
    // Block inserts are disabled inside a task item…
    await expect(menu.locator(".pm-slash-item", { hasText: /^Table$/ })).toHaveCount(0);
    await expect(
      menu.locator(".pm-slash-item", { hasText: "Table of contents" }),
    ).toHaveCount(0);
    await expect(menu.locator(".pm-slash-item", { hasText: "SQL query" })).toHaveCount(0);
    // …while inline atoms stay available.
    await expect(menu.locator(".pm-slash-item", { hasText: /^Today$/ })).toHaveCount(1);
    await page.keyboard.press("Escape");
  });
});
