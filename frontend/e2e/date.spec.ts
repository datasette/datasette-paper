/**
 * E2E for the inline `date` atom. Covers the three things unit tests can't
 * assert in a real browser:
 *
 *  1. Authoring — the slash menu inserts today's chip and opens its popup;
 *     retargeting to an ABSOLUTE date (no "tomorrow" clock coupling) commits
 *     new attrs the chip reflects.
 *  2. Round-trip — a chip's attrs persist to the `paper:/date/` markdown link
 *     via `/document`, and a seeded timed+tz date renders back as a chip.
 *  3. Overdue tint — a past date inside an UNCHECKED task tints
 *     `pp-date-overdue`; checking the box clears it WITHOUT a reload (the
 *     decoration plugin recomputes on the checkbox's setNodeMarkup — the
 *     regression the plugin design exists for).
 *
 * All locators are scoped to `#app-root` (the debug bar injects an "act as"
 * <select> outside it — see e2e/CLAUDE.md). Build the bundle first
 * (`just frontend`) or the page loads nothing.
 */
import { test, expect } from "@playwright/test";
import { gotoPaper } from "./helpers";

const BASE = "/-/paper";

async function seed(page: import("@playwright/test").Page, name: string, content: string) {
  const resp = await page.request.post(`${BASE}/api/docs`, {
    data: { name, content, content_type: "markdown" },
  });
  expect(resp.status()).toBe(201);
  return (await resp.json()).id as number;
}

test.describe("date atom", () => {
  test("slash-insert then popup-edit to an absolute date", async ({ page }) => {
    const resp = await page.request.post(`${BASE}/api/docs`, {
      data: { name: "Date Author Host" },
    });
    expect(resp.status()).toBe(201);
    const { id } = await resp.json();
    await gotoPaper(page, `${BASE}/doc/${id}`);

    const app = page.locator("#app-root");
    const editor = app.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("/date");

    // Slash menu filters to the Date entry; Enter runs it.
    await expect(app.locator(".pm-slash-menu")).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Enter");

    // Insert opens the popup on the fresh chip (via rAF).
    const popup = app.locator(".pm-date-popup");
    await expect(popup).toBeVisible({ timeout: 10000 });

    // Retarget to an absolute date so the assertion is clock-independent.
    const input = popup.locator(".pm-date-popup-input");
    await input.fill("2030-03-15");
    await expect(popup.locator(".pm-date-popup-preview")).toContainText("Mar 15, 2030");
    await page.keyboard.press("Enter");

    await expect(popup).toBeHidden({ timeout: 10000 });
    const chip = app.locator(".pm-date");
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip).toHaveText(/Mar 15, 2030/);
    await expect(chip).toHaveAttribute("data-date", "2030-03-15");

    // The attrs persist as a paper:/date/ markdown link.
    await expect
      .poll(
        async () => {
          const r = await page.request.get(`${BASE}/api/docs/${id}/document`);
          if (!r.ok()) return "";
          return (await r.json()).content_markdown as string;
        },
        { timeout: 10000, message: "date atom never persisted to markdown" },
      )
      .toContain("paper:/date/2030-03-15");
  });

  test("/tomorrow inserts a resolved chip directly, no popup", async ({ page }) => {
    const resp = await page.request.post(`${BASE}/api/docs`, {
      data: { name: "Date Quick Insert Host" },
    });
    expect(resp.status()).toBe(201);
    const { id } = await resp.json();
    await gotoPaper(page, `${BASE}/doc/${id}`);

    const app = page.locator("#app-root");
    await app.locator(".ProseMirror").click();
    await page.keyboard.type("/tomorrow");
    await expect(app.locator(".pm-slash-menu")).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Enter");

    // A chip appears immediately; no popup opens for the quick-insert path.
    const chip = app.locator(".pm-date");
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(app.locator(".pm-date-popup")).toHaveCount(0);
    // Its date is a real ISO date (exact value is clock-dependent, so just
    // assert the shape).
    await expect(chip).toHaveAttribute("data-date", /^\d{4}-\d{2}-\d{2}$/);
  });

  test("picking a format preset persists the fmt param through markdown", async ({
    page,
  }) => {
    const id = await seed(
      page,
      "Date Format Host",
      "due [Jul 20, 2026](paper:/date/2026-07-20)\n",
    );
    await gotoPaper(page, `${BASE}/doc/${id}`);

    const app = page.locator("#app-root");
    const chip = app.locator(".pm-date");
    await expect(chip).toBeVisible({ timeout: 10000 });
    await chip.click();

    // The ISO preset button is labelled with its rendered example.
    await app.locator('.pm-date-format[data-format="%Y-%m-%d"]').click();
    await page.keyboard.press("Enter");

    await expect(app.locator(".pm-date-popup")).toHaveCount(0);
    await expect(chip).toHaveText(/2026-07-20/);
    await expect(chip).toHaveAttribute("data-date-format", "%Y-%m-%d");

    // The format rides the markdown as a fmt query param.
    await expect
      .poll(
        async () => {
          const r = await page.request.get(`${BASE}/api/docs/${id}/document`);
          if (!r.ok()) return "";
          return (await r.json()).content_markdown as string;
        },
        { timeout: 10000, message: "date format never persisted" },
      )
      .toContain("fmt=%25Y-%25m-%25d");
  });

  test("Cmd/Ctrl-; and Cmd/Ctrl-Shift-; insert today/tomorrow at the cursor", async ({
    page,
  }) => {
    const resp = await page.request.post(`${BASE}/api/docs`, {
      data: { name: "Date Keyboard Host" },
    });
    expect(resp.status()).toBe(201);
    const { id } = await resp.json();
    await gotoPaper(page, `${BASE}/doc/${id}`);

    const app = page.locator("#app-root");
    await app.locator(".ProseMirror").click();
    // "Mod" resolves to Meta/Control exactly as prosemirror-keymap decides it
    // (from navigator.platform in THIS browser, which may differ from the host).
    const isMac = await page.evaluate(() => /Mac/.test(navigator.platform));
    const mod = isMac ? "Meta" : "Control";

    await page.keyboard.press(`${mod}+Semicolon`);
    await page.keyboard.press(`${mod}+Shift+Semicolon`);

    const chips = app.locator(".pm-date");
    await expect(chips).toHaveCount(2, { timeout: 10000 });
    // Two real ISO dates, no popup opened.
    await expect(app.locator(".pm-date-popup")).toHaveCount(0);
    const first = await chips.nth(0).getAttribute("data-date");
    const second = await chips.nth(1).getAttribute("data-date");
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(second).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Tomorrow is strictly after today.
    expect(second! > first!).toBe(true);
  });

  test("a seeded timed+tz date renders a chip", async ({ page }) => {
    const id = await seed(
      page,
      "Date Render Target",
      "Meet at [Jul 20, 2026 3:00 PM](paper:/date/2026-07-20T15:00?tz=America%2FLos_Angeles)\n",
    );
    await gotoPaper(page, `${BASE}/doc/${id}`);

    const chip = page.locator("#app-root .pm-date");
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip).toHaveAttribute("data-date", "2026-07-20");
    await expect(chip).toHaveAttribute("data-date-time", "15:00");
    await expect(chip).toHaveAttribute("data-date-tz", "America/Los_Angeles");
  });

  test("a timed date is visibly converted across midnight into the reader's zone", async ({
    browser,
  }) => {
    const context = await browser.newContext({ timezoneId: "Asia/Tokyo" });
    const page = await context.newPage();
    try {
      const id = await seed(
        page,
        "Date Cross-Zone Render Target",
        "Meet at [2026-07-20 3:00 PM]"
          + "(paper:/date/2026-07-20T15:00?tz=America%2FLos_Angeles&fmt=%25Y-%25m-%25d)\n",
      );
      await gotoPaper(page, `${BASE}/doc/${id}`);

      const chip = page.locator("#app-root .pm-date");
      await expect(chip).toHaveText(/2026-07-21, 7:00 AM/);
      await expect(chip).toHaveAttribute("title", /author's time/);
    } finally {
      await context.close();
    }
  });

  test("task tint boundaries cover today, prose, and initially checked tasks", async ({
    page,
  }) => {
    const today = await page.evaluate(() => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    });
    const id = await seed(
      page,
      "Date Tint Boundaries",
      [
        `prose [today](paper:/date/${today})`,
        `- [ ] due [today](paper:/date/${today})`,
        "- [x] old [past](paper:/date/2020-01-02)",
      ].join("\n"),
    );
    await gotoPaper(page, `${BASE}/doc/${id}`);

    const chips = page.locator("#app-root .pm-date");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).not.toHaveClass(/pp-date-(today|overdue)/);
    await expect(chips.nth(1)).toHaveClass(/pp-date-today/);
    await expect(chips.nth(2)).not.toHaveClass(/pp-date-(today|overdue)/);
  });

  test("a past date tints overdue inside an unchecked task and clears on check", async ({
    page,
  }) => {
    // A task with a clearly past date (absolute, well before any test run).
    const id = await seed(
      page,
      "Date Overdue Host",
      "- [ ] ship it by [Jan 2, 2020](paper:/date/2020-01-02)\n",
    );
    await gotoPaper(page, `${BASE}/doc/${id}`);

    const app = page.locator("#app-root");
    const chip = app.locator(".pm-date");
    await expect(chip).toBeVisible({ timeout: 10000 });
    // The decoration plugin tints it overdue because it sits in an unchecked task.
    await expect(chip).toHaveClass(/pp-date-overdue/, { timeout: 10000 });

    // Check the box — a setNodeMarkup on the ANCESTOR task_item. The tint must
    // clear without a reload (decorations recompute on the transaction).
    await app.locator("li[data-task-item] input[type=checkbox]").first().check();
    await expect(chip).not.toHaveClass(/pp-date-overdue/, { timeout: 10000 });
  });
});
