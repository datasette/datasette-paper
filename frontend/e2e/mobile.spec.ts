/**
 * E2E for mobile-support toolbar work:
 *  - the `[[` wiki-link starter button (works at any width);
 *  - the bottom-pinned, single-row toolbar + hide-keyboard button on phones;
 *  - the floating scroll-to-top button on long docs.
 *
 * Keyboard-offset (VisualViewport) and actual keyboard dismissal can't be
 * exercised headlessly — headless chromium has no software keyboard — so those
 * are covered by the manual device checklist in the ticket, not here.
 */
import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper } from "./helpers";

test.describe("wiki-link starter", () => {
  test("the Link ▾ menu's 'Link to a page' row opens the autocomplete", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    // Place the cursor in the editor first so the insert has a selection.
    await page.locator(".ProseMirror").click();

    // Post-redesign (ticket 02) the wiki-link starter is a row inside the
    // Link ▾ dropdown, not a top-level toolbar button. Open the menu first.
    const root = page.locator("#app-root");
    await root.getByRole("button", { name: "Link", exact: true }).click();
    const row = root.getByRole("menuitem", { name: /Link to a page/ });
    await expect(row).toBeVisible();
    await row.click();

    // Inserting `[[` trips the wikiLinkSuggest trigger exactly like typing it.
    await expect(page.locator(".pm-wikilink-popup")).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe("mobile toolbar layout", () => {
  test.use({
    viewport: { width: 375, height: 667 },
    hasTouch: true,
    isMobile: true,
  });

  test("toolbar pins to the bottom as a single non-scrolling row", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const toolbar = page.locator("#app-root .paper-toolbar");
    await expect(toolbar).toBeVisible();

    const layout = await toolbar.evaluate((el) => {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        position: cs.position,
        flexWrap: cs.flexWrap,
        overflowX: cs.overflowX,
        // scrollWidth > clientWidth ⇒ the row overflows and scrolls.
        overflows: el.scrollWidth > el.clientWidth,
        bottom: rect.bottom,
        innerHeight: window.innerHeight,
      };
    });

    expect(layout.position).toBe("fixed");
    expect(layout.flexWrap).toBe("nowrap");
    // overflow-x stays as a safety valve, but at this 375px viewport (iPhone
    // SE/mini — the small end of current phones) the slim strip fits without
    // engaging it; only the legacy 320px floor still scrolls.
    expect(layout.overflowX).toBe("auto");
    expect(layout.overflows).toBe(false);
    // Pinned to the bottom edge of the viewport (keyboard closed ⇒ offset 0).
    expect(Math.abs(layout.bottom - layout.innerHeight)).toBeLessThan(2);
  });

  test("redo is dropped from the strip; undo stays", async ({ page }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const root = page.locator("#app-root");
    // Redo is dropped on mobile (⌘⇧Z / three-finger redo cover it); undo stays.
    await expect(root.getByRole("button", { name: "Redo" })).toHaveCount(0);
    await expect(root.getByRole("button", { name: "Undo" })).toBeVisible();
  });

  test("＋ Insert opens as a full-width bottom sheet above the strip", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const root = page.locator("#app-root");
    // The debug bar (outside #app-root) overlaps the bottom edge in this
    // viewport and would intercept a positional click on the pinned strip, so
    // dispatch the click directly — that overlay doesn't exist in the real app.
    await root
      .getByRole("button", { name: "Insert", exact: true })
      .dispatchEvent("click");

    const sheet = root.locator(".tb-insert-menu");
    await expect(sheet).toBeVisible();

    const info = await sheet.evaluate((el) => {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const grid = el.querySelector(".tb-insert-grid") as HTMLElement;
      return {
        position: cs.position,
        hasSheetClass: el.classList.contains("tb-sheet"),
        // A `repeat(4, 1fr)` grid resolves to four track widths.
        gridTracks: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        fullWidth: Math.abs(rect.width - window.innerWidth) < 2,
        // Sits above the bottom-pinned strip, not under it / off-screen.
        aboveStrip: rect.bottom < window.innerHeight - 1,
        // Grab-handle pseudo-element is drawn (::before has content).
        hasGrabHandle:
          getComputedStyle(el, "::before").content !== "none",
      };
    });

    expect(info.position).toBe("fixed");
    expect(info.hasSheetClass).toBe(true);
    expect(info.gridTracks).toBe(4);
    expect(info.fullWidth).toBe(true);
    expect(info.aboveStrip).toBe(true);
    expect(info.hasGrabHandle).toBe(true);
  });

  test("hide-keyboard button is present and outside the scrolling strip", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const hide = page.locator("#app-root .tb-hide-keyboard");
    await expect(hide).toBeVisible();

    // It must not be a descendant of the scrolling `.paper-toolbar` — otherwise
    // it would scroll away with the buttons.
    const nested = await hide.evaluate(
      (el) => !!el.closest(".paper-toolbar"),
    );
    expect(nested).toBe(false);

    // Anchored to the right edge.
    const rightGap = await hide.evaluate(
      (el) => window.innerWidth - el.getBoundingClientRect().right,
    );
    expect(rightGap).toBeLessThan(2);
  });

  test("header metadata and actions stack instead of squishing", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    // Wait for the header to load (meta comes from an API fetch).
    const actions = page.locator("#app-root .meta-actions");
    await expect(actions).toBeVisible();

    const stacked = await page.evaluate(() => {
      const meta = document.querySelector(".meta") as HTMLElement;
      const by = document.querySelector(".created-by") as HTMLElement;
      const acts = document.querySelector(".meta-actions") as HTMLElement;
      return {
        wrap: getComputedStyle(meta).flexWrap,
        // Actions sit on a line below the "by …" text, not beside it.
        actionsBelow: acts.offsetTop > by.offsetTop,
        // "by <name>" stays on one line (no mid-phrase wrapping).
        byNoWrap: getComputedStyle(by).whiteSpace === "nowrap",
      };
    });
    expect(stacked.wrap).toBe("wrap");
    expect(stacked.actionsBelow).toBe(true);
    expect(stacked.byNoWrap).toBe(true);
  });

  test("desktop keeps the top, single-row toolbar with redo", async ({
    page,
  }) => {
    // Override the mobile viewport for this one case.
    await page.setViewportSize({ width: 1200, height: 900 });
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const toolbar = page.locator("#app-root .paper-toolbar");
    const style = await toolbar.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { position: cs.position, flexWrap: cs.flexWrap };
    });
    expect(style.position).toBe("sticky");
    // The redesigned strip never wraps by construction (design.md §Final
    // control set) — flex-wrap is removed on both desktop and mobile.
    expect(style.flexWrap).toBe("nowrap");
    // Redo stays on desktop (only the mobile strip drops it).
    await expect(
      page.locator("#app-root").getByRole("button", { name: "Redo" }),
    ).toBeVisible();
    // No hide-keyboard button on desktop.
    await expect(page.locator("#app-root .tb-hide-keyboard")).toHaveCount(0);
  });
});

test.describe("mobile sidebar collapse", () => {
  test.use({
    viewport: { width: 375, height: 667 },
    hasTouch: true,
    isMobile: true,
  });

  test("rail collapses to a 3-dot menu and drops the reserved margin", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    // The always-on vertical rail is gone; a single 3-dot button stands in.
    await expect(page.locator("#app-root .paper-rail")).toHaveCount(0);
    const btn = page.locator("#app-root .paper-rail-mobile-btn");
    await expect(btn).toBeVisible();

    // No awkward reserved right margin on the document column.
    const padRight = await page.evaluate(() => {
      const el = document.querySelector(".datasette-paper-app") as HTMLElement;
      return getComputedStyle(el).paddingRight;
    });
    expect(padRight).toBe("16px");

    // Tapping opens the section picker; picking Links opens the overlay panel.
    await btn.dispatchEvent("click");
    const menu = page.locator("#app-root .paper-rail-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Links" }).dispatchEvent("click");
    await expect(page.locator("#app-root .paper-rail-flyout")).toBeVisible();

    // The backdrop dismisses it.
    await page.locator("#app-root .paper-rail-backdrop").dispatchEvent("click");
    await expect(page.locator("#app-root .paper-rail-flyout")).toHaveCount(0);
  });
});

test.describe("scroll-to-top button", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("appears after scrolling and returns to the top", async ({ page }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    // Build a doc tall enough to scroll well past the 600px threshold.
    const editor = page.locator(".ProseMirror");
    await editor.click();
    for (let i = 0; i < 80; i++) await page.keyboard.press("Enter");

    // Typing auto-scrolls the cursor into view, so return to the top first.
    await page.evaluate(() => window.scrollTo(0, 0));

    const btn = page.locator("#app-root .scroll-to-top");
    // Hidden at the top.
    await expect(btn).toHaveCount(0);

    // Scroll down.
    await page.mouse.wheel(0, 1200);
    await expect(btn).toBeVisible({ timeout: 10000 });

    // Tapping it returns to the top. Dispatch the click directly on the
    // element: the e2e harness injects a fixed debug bar (outside #app-root)
    // that overlaps the bottom-right in this viewport and would intercept a
    // positional click — that overlay doesn't exist in the real app.
    await btn.dispatchEvent("click");
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { timeout: 10000 })
      .toBeLessThan(5);
    await expect(btn).toHaveCount(0);
  });
});
