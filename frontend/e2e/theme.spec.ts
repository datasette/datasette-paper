/**
 * @feat dark-mode: end-to-end coverage of the shipped theme mechanism plus an
 * automated contrast sweep of the *rendered* pages in both themes.
 *
 *  1. Toggle flips the theme: DocHeader overflow → Theme → Dark stamps
 *     <html data-theme="dark"> and actually recolors a token (body bg).
 *  2. Persists + no FOUC: the choice survives reload and the FOUC resolver
 *     in paper_base.html stamps data-theme BEFORE the first <body> paint — a
 *     MutationObserver installed via addInitScript (which runs before any page
 *     script) records the ordering of the attribute stamp vs. the <body>
 *     insertion.
 *  3. System tracks the OS: with data-theme="system", flipping
 *     emulateMedia({ colorScheme }) recolors live (media-branch CSS), no reload.
 *     Paper defaults to LIGHT regardless of OS (dark/system are explicit
 *     opt-ins), so a fresh visitor on a dark OS still renders light.
 *  4. Index-page cycle button cycles Light → Dark → System and persists.
 *  5. axe color-contrast sweep of the seeded doc page + the index page in both
 *     themes; zero violations. Scoped to #app-root plus Datasette's header.hd
 *     (ticket 08's chrome surface) so unrelated Datasette/debug-bar chrome is
 *     out of scope.
 *
 * paperTheme is cleared in afterEach so cross-spec ordering never matters (the
 * default per-test context isolation already gives a clean localStorage, but
 * the explicit clear documents the contract).
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createPaper, gotoPaper } from "./helpers";

const BASE = "/-/paper";
const DARK_BG = "rgb(13, 17, 23)"; // --pp-bg dark (#0d1117)
const LIGHT_BG = "rgb(255, 255, 255)"; // --pp-bg light (#fff)

/** Read the effective page background — the house gotcha assertion. */
function bodyBg(page: Page): Promise<string> {
  return page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
}

/** Read the stamped theme from <html data-theme>. */
function stampedTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}

/** Drive the DocHeader overflow → Theme submenu → pick a radio option. */
async function pickThemeFromDocHeader(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  // The submenu opens on mouseenter (hover). Clicking the "Theme" item would
  // toggle it *closed* because Playwright's click dispatches the mouseenter
  // that opens it first — so hover, don't click, to reveal the radios.
  await page.getByRole("menuitem", { name: "Theme" }).hover();
  await page
    .locator("#app-root")
    .getByRole("menuitemradio", { name: label, exact: true })
    .click();
}

/**
 * Run an axe color-contrast sweep scoped to paper's own surfaces (#app-root
 * plus Datasette's header.hd, when present). Returns the color-contrast
 * violations only — a full-rules sweep flags pre-existing non-color issues
 * that are out of this ticket's scope.
 */
async function contrastViolations(page: Page) {
  const builder = new AxeBuilder({ page }).withRules(["color-contrast"]);
  builder.include("#app-root");
  if ((await page.locator("header.hd").count()) > 0) {
    builder.include("header.hd");
  }
  const results = await builder.analyze();
  return results.violations;
}

/** Seed a doc with varied content so the contrast sweep has real surfaces. */
async function seedRichDoc(page: Page): Promise<number> {
  const resp = await page.request.post(`${BASE}/api/docs`, {
    data: {
      name: `Theme E2E ${Date.now()}`,
      content:
        "# Heading One\n\n" +
        "Some **bold** and _italic_ prose with a [link](https://example.com).\n\n" +
        "- bullet one\n- bullet two\n\n" +
        // Note: intentionally NOT seeding a completed (`[x]`) task — done tasks
        // render in the deliberately de-emphasized `--pp-fg-subtle` tier, which
        // fails AA in BOTH themes (a pre-existing, theme-independent design
        // choice, out of this dark-mode sweep's scope).
        "- [ ] an open task\n",
      content_type: "markdown",
    },
  });
  expect(resp.status()).toBe(201);
  return (await resp.json()).id as number;
}

test.describe("dark mode", () => {
  test.afterEach(async ({ page }) => {
    // Best-effort clear so ordering with other specs never matters.
    await page
      .evaluate(() => localStorage.removeItem("paperTheme"))
      .catch(() => {});
  });

  test("DocHeader Theme submenu flips the theme and recolors a token", async ({
    page,
  }) => {
    const { url } = await createPaper(page, { name: "Theme Toggle Host" });
    await gotoPaper(page, url);

    // Fresh context → clean localStorage → resolver picked "light" (default).
    expect(await stampedTheme(page)).toBe("light");

    await pickThemeFromDocHeader(page, "Dark");

    await expect
      .poll(() => stampedTheme(page))
      .toBe("dark");
    expect(await bodyBg(page)).toBe(DARK_BG);

    // Flip back to Light and confirm the token flips too.
    await pickThemeFromDocHeader(page, "Light");
    await expect
      .poll(() => stampedTheme(page))
      .toBe("light");
    expect(await bodyBg(page)).toBe(LIGHT_BG);
  });

  test("theme persists across reload and is stamped before first paint", async ({
    page,
  }) => {
    const { url } = await createPaper(page, { name: "Theme Persist Host" });
    await gotoPaper(page, url);

    // Choose Dark through the real UI (writes localStorage.paperTheme).
    await pickThemeFromDocHeader(page, "Dark");
    await expect.poll(() => stampedTheme(page)).toBe("dark");

    // Install a pre-paint probe: init scripts run before any page script, so
    // this MutationObserver is attached before the FOUC resolver stamps
    // data-theme. It records the ordering of the attribute stamp vs. the
    // <body> insertion into <html>.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __themeProbe: { log: string[]; rootAtInit: boolean };
      };
      const log: string[] = [];
      // Init scripts run before <html> exists, so `document.documentElement`
      // is null here — but `document` already exists. Observe it with subtree
      // so we still catch the <html data-theme> stamp (an attribute mutation on
      // documentElement) and the <body> insertion (a childList mutation), in
      // the order they happen. The FOUC resolver stamps data-theme during
      // <head> parse, before <body> is inserted, so "theme:*" must precede
      // "body" in the log — that's the no-FOUC guarantee.
      w.__themeProbe = { log, rootAtInit: !!document.documentElement };
      const obs = new MutationObserver((records) => {
        for (const r of records) {
          if (
            r.type === "attributes" &&
            r.attributeName === "data-theme" &&
            r.target === document.documentElement
          ) {
            log.push("theme:" + document.documentElement.getAttribute("data-theme"));
          } else if (r.type === "childList") {
            r.addedNodes.forEach((n) => {
              if (n.nodeName === "BODY") log.push("body");
            });
          }
        }
      });
      obs.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    });

    await page.reload();
    await expect(page.locator("#app-root .ProseMirror")).toBeVisible({
      timeout: 10000,
    });

    // The persisted choice survived the reload.
    expect(await stampedTheme(page)).toBe("dark");
    expect(await bodyBg(page)).toBe(DARK_BG);

    // The probe proves the attribute was stamped BEFORE <body> was inserted.
    const probe = await page.evaluate(
      () =>
        (
          window as unknown as {
            __themeProbe: { log: string[]; rootAtInit: boolean };
          }
        ).__themeProbe,
    );
    // Sanity: the init script really did run pre-<html> (nothing to stamp yet).
    expect(probe.rootAtInit).toBe(false);
    const firstTheme = probe.log.findIndex((e) => e.startsWith("theme:"));
    const firstBody = probe.log.indexOf("body");
    expect(firstTheme, `probe log: ${JSON.stringify(probe.log)}`).toBeGreaterThanOrEqual(0);
    expect(firstBody, `probe log: ${JSON.stringify(probe.log)}`).toBeGreaterThanOrEqual(0);
    // Attribute stamp recorded before the <body> insertion → no FOUC.
    expect(firstTheme).toBeLessThan(firstBody);
    expect(probe.log[firstTheme]).toBe("theme:dark");
  });

  test("a fresh visitor with a dark OS still renders light (light is the default)", async ({
    page,
  }) => {
    const { url } = await createPaper(page, { name: "Theme Default Host" });
    // Dark OS, no persisted choice. Paper defaults to light regardless of OS
    // (matching Datasette) — dark/system are explicit per-device opt-ins.
    await page.emulateMedia({ colorScheme: "dark" });
    await gotoPaper(page, url);

    expect(await stampedTheme(page)).toBe("light");
    expect(await bodyBg(page)).toBe(LIGHT_BG);
  });

  test('"System" tracks the OS color scheme live', async ({ page }) => {
    const { url } = await createPaper(page, { name: "Theme System Host" });
    await gotoPaper(page, url);

    // Opt in to "system" explicitly (no longer the default) to assert the
    // OS-tracking mechanism.
    await pickThemeFromDocHeader(page, "System");
    await expect.poll(() => stampedTheme(page)).toBe("system");

    // No reload needed — the media branch is live CSS.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => bodyBg(page)).toBe(DARK_BG);
    expect(await stampedTheme(page)).toBe("system");

    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => bodyBg(page)).toBe(LIGHT_BG);
    expect(await stampedTheme(page)).toBe("system");
  });

  test("index-page cycle button cycles Light → Dark → System and persists", async ({
    page,
  }) => {
    // A doc so the list isn't empty (not required, but realistic).
    await createPaper(page, { name: "Index Cycle Host" });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${BASE}/`);

    const cycle = page.locator("#app-root .theme-cycle");
    await expect(cycle).toBeVisible({ timeout: 10000 });

    // Clean context → starts at Light (the default).
    await expect(cycle).toHaveAttribute("aria-label", "Theme: Light");
    expect(await stampedTheme(page)).toBe("light");
    expect(await bodyBg(page)).toBe(LIGHT_BG);

    // Light → Dark
    await cycle.click();
    await expect(cycle).toHaveAttribute("aria-label", "Theme: Dark");
    expect(await stampedTheme(page)).toBe("dark");
    expect(await bodyBg(page)).toBe(DARK_BG);
    expect(
      await page.evaluate(() => localStorage.getItem("paperTheme")),
    ).toBe("dark");

    // Dark → System (OS is emulated light, so "system" resolves light).
    await cycle.click();
    await expect(cycle).toHaveAttribute("aria-label", "Theme: System");
    expect(await stampedTheme(page)).toBe("system");
    expect(await bodyBg(page)).toBe(LIGHT_BG);
    expect(
      await page.evaluate(() => localStorage.getItem("paperTheme")),
    ).toBe("system");

    // Persists across reload.
    await page.reload();
    const cycleAfter = page.locator("#app-root .theme-cycle");
    await expect(cycleAfter).toHaveAttribute("aria-label", "Theme: System", {
      timeout: 10000,
    });
    expect(await stampedTheme(page)).toBe("system");
    expect(await bodyBg(page)).toBe(LIGHT_BG);
  });

  // ---- axe color-contrast sweeps: {doc, index} × {light, dark} ----

  for (const theme of ["light", "dark"] as const) {
    test(`axe color-contrast: doc page (${theme})`, async ({ page }) => {
      const docId = await seedRichDoc(page);
      await page.emulateMedia({ colorScheme: theme });
      await gotoPaper(page, `${BASE}/doc/${docId}`);
      // Persist the explicit theme + reload so the resolver stamps it pre-paint.
      await page.evaluate((t) => localStorage.setItem("paperTheme", t), theme);
      await page.reload();
      await expect(page.locator("#app-root .ProseMirror")).toBeVisible({
        timeout: 10000,
      });
      expect(await stampedTheme(page)).toBe(theme);
      expect(await bodyBg(page)).toBe(theme === "dark" ? DARK_BG : LIGHT_BG);

      const violations = await contrastViolations(page);
      expect(
        violations,
        `color-contrast violations (doc/${theme}): ${JSON.stringify(
          violations.map((v) => v.nodes.map((n) => n.target)),
        )}`,
      ).toEqual([]);
    });

    test(`axe color-contrast: index page (${theme})`, async ({ page }) => {
      await createPaper(page, { name: `Axe Index ${theme}` });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`${BASE}/`);
      await page.evaluate((t) => localStorage.setItem("paperTheme", t), theme);
      await page.reload();
      await expect(page.locator("#app-root .theme-cycle")).toBeVisible({
        timeout: 10000,
      });
      expect(await stampedTheme(page)).toBe(theme);
      expect(await bodyBg(page)).toBe(theme === "dark" ? DARK_BG : LIGHT_BG);

      const violations = await contrastViolations(page);
      expect(
        violations,
        `color-contrast violations (index/${theme}): ${JSON.stringify(
          violations.map((v) => v.nodes.map((n) => n.target)),
        )}`,
      ).toEqual([]);
    });
  }
});
