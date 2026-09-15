/**
 * E2E: Escape coexistence with the Sidebar panel (plans/shortcuts ticket 06).
 * With a rail panel open, one Escape must close only the innermost
 * interaction. Each case below closed the Sidebar as well before its fix:
 *   - B4  link edit dialog (lives outside view.dom; Sidebar now skips
 *         defaultPrevented Escapes)
 *   - B9  Datasette embed <dialog> (dialog stops the keydown)
 *   - B11 NodeView ⋮ menu with focus on its button (menu claims Escape)
 *
 * Locators are scoped to `#app-root` per the debug-bar "act as" gotcha.
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoPaper } from "./helpers";

const BASE = `/-/paper`;

async function createSeededPaper(page: Page, content: string): Promise<string> {
  const name = `Escape-E2E-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await page.request.post(`${BASE}/api/docs`, { data: { name, content } });
  expect(r.status()).toBe(201);
  return `${BASE}/doc/${(await r.json()).id}`;
}

async function openLinksPanel(page: Page) {
  const app = page.locator("#app-root");
  await app.getByRole("button", { name: "Links", exact: true }).click();
  const flyout = app.locator(".paper-rail-flyout");
  await expect(flyout).toBeVisible();
  return flyout;
}

test.describe("Escape with the Sidebar panel open", () => {
  test("B4: closes the link edit dialog, not the panel", async ({ page }) => {
    await gotoPaper(page, await createSeededPaper(page, "The [Datasette](https://datasette.io) project.\n"));
    const app = page.locator("#app-root");
    const flyout = await openLinksPanel(page);

    await app.locator(".ProseMirror a", { hasText: "Datasette" }).hover();
    await app.locator(".pm-link-tooltip-edit").click();
    const dialog = app.locator(".pm-link-edit-dialog");
    await expect(dialog).toBeVisible();
    await app.locator(".pm-link-edit-input").last().focus();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(flyout).toBeVisible();
  });

  test("B9: closes the Datasette embed dialog, not the panel", async ({ page }) => {
    await gotoPaper(page, await createSeededPaper(page, "Intro paragraph.\n"));
    const app = page.locator("#app-root");
    const flyout = await openLinksPanel(page);

    await app.locator(".ProseMirror p", { hasText: "Intro paragraph" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/embed");
    await app.locator(".pm-slash-item", { hasText: "Embed a table" }).first().click();
    const dialog = app.locator("dialog[open]");
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(flyout).toBeVisible();
  });

  test("B11: closes a TOC ⋮ menu focused by keyboard, not the panel, no node selection", async ({
    page,
  }) => {
    await gotoPaper(
      page,
      await createSeededPaper(page, "# Handbook\n\n```paper-toc\n```\n\nIntro paragraph.\n\n## Setup\n"),
    );
    const app = page.locator("#app-root");
    const flyout = await openLinksPanel(page);

    await app.locator(".ProseMirror p", { hasText: "Intro paragraph" }).click();
    await app.locator(".pm-toc-menu-btn").focus();
    await page.keyboard.press("Enter");
    const menu = app.locator(".pm-toc-menu--open");
    await expect(menu).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(flyout).toBeVisible();
    const selType = await page.evaluate(
      () =>
        (window as unknown as { __pmView: { state: { selection: { toJSON(): { type: string } } } } })
          .__pmView.state.selection.toJSON().type,
    );
    expect(selType).not.toBe("node");
  });
});
