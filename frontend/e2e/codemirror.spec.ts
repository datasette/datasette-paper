/**
 * E2E for the CodeMirror workstream (plans/codemirror/) — the three-tier
 * hybrid (static lezer highlight, CM6-on-focus, curated language registry)
 * across `code_block` / `sql_block`. Locators are scoped to `#app-root`
 * (the debug-bar "act as" select gotcha — see e2e/CLAUDE.md).
 *
 * Covers:
 *   1. Typing flow: ` ```py ` + space creates a `code_block`, typing
 *      `def f():` renders a `span.tok-keyword` (proves the lezer grammar
 *      chunk loaded), model-asserted `language` attr via the document model
 *      (frontend/CLAUDE.md: debug via the model, not the DOM).
 *   2. CM mount lifecycle: clicking in mounts `.cm-editor`; arrowing out
 *      unmounts it, the static `<pre>` returns with the edit intact, and
 *      `window.scrollY` doesn't jump across the swap (the commit `93d66f2`
 *      concern).
 *   3. Language picker: hover reveals the corner chrome, filtering narrows
 *      the list, picking a language recolors the block (`tok-*` classes
 *      from the newly mounted grammar).
 *   4. Viewer cost: a locked (read-only) doc still gets tier-0 highlight,
 *      but never fetches the `cm-core` chunk and never mounts `.cm-editor`
 *      on click.
 *   5. SQL block: editing in CM, Mod-Enter re-runs the query, and the
 *      staleness cue toggles off/on around the run.
 *
 * Where valuable, also asserts the T08/T09 bugfixes: spellcheck="false" on
 * both code surfaces, and contenteditable="false" on the SQL results chrome.
 */
import { test, expect, type Page } from "@playwright/test";
import { cookieHeader, gotoPaper, readEditorState } from "./helpers";

const BASE = `/-/paper`;

/** Create a paper seeded with markdown `content` (the create-from-markdown
 * API — see datasette_paper/routes/docs.py's CreateDocBody). `createPaper` in
 * helpers.ts doesn't expose `content`, so these specs post directly. */
async function createSeededPaper(
  page: Page,
  content: string,
  opts: { actorId?: string } = {},
): Promise<{ id: number; url: string }> {
  const name = `CM-E2E-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestOpts: Parameters<typeof page.request.post>[1] = {
    data: { name, content },
  };
  if (opts.actorId) {
    requestOpts.headers = { Cookie: cookieHeader(opts.actorId) };
  }
  const r = await page.request.post(`${BASE}/api/docs`, requestOpts);
  expect(r.status()).toBe(201);
  const body = await r.json();
  return { id: body.id, url: `${BASE}/doc/${body.id}` };
}

test.describe("code_block: typing flow", () => {
  // @feat code-language: e2e proves the ```lang input rule + tier-0 highlight
  test("```py` + space creates a code block; typing colors a keyword and sets the language attr", async ({
    page,
  }) => {
    const r = await page.request.post(`${BASE}/api/docs`, {
      data: { name: `CM-E2E-typing-${Date.now()}` },
    });
    expect(r.status()).toBe(201);
    const { id } = await r.json();
    await gotoPaper(page, `${BASE}/doc/${id}`);

    const app = page.locator("#app-root");
    const editor = app.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("```py");
    await page.keyboard.press("Space");

    const block = app.locator(".pm-code-block");
    await expect(block).toBeVisible({ timeout: 10000 });

    await page.keyboard.type("def f():");
    // Static tier proves the lezer python grammar chunk resolved.
    await expect(block.locator("span.tok-keyword")).toBeVisible({ timeout: 10000 });
    await expect(block.locator("span.tok-keyword").first()).toHaveText("def");

    // Debug via the document model (frontend/CLAUDE.md), not the DOM: the
    // rendered `pre` doesn't expose node attrs.
    const state = await readEditorState(page);
    const doc = state.doc as { content: Array<{ type: string; attrs?: Record<string, unknown> }> };
    const codeNode = doc.content.find((n) => n.type === "code_block");
    expect(codeNode).toBeTruthy();
    expect(codeNode!.attrs?.language).toBe("py");
  });
});

test.describe("code_block: CM mount lifecycle", () => {
  // @feat code-cm-focus: e2e proves the focus-in/arrow-out mode swap + no scroll jump
  test("clicking in mounts CM; arrowing out unmounts it with no scroll jump and the edit intact", async ({
    page,
  }) => {
    const host = await createSeededPaper(
      page,
      "```py\nx = 1\n```\n\nAfter the code block.\n",
    );
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const block = app.locator(".pm-code-block");
    await expect(block).toBeVisible({ timeout: 10000 });
    await expect(block.locator(".cm-editor")).toHaveCount(0);

    // Wait for tier-0 static highlighting to settle before clicking, and
    // force the click: the async decoration pass (and the corner language
    // button's hover-reveal transition sitting over the same block) can
    // keep reflowing/repainting long enough that Playwright's click-
    // stability polling never converges, even once the block is
    // functionally idle.
    await expect(block.locator("span.tok-number")).toBeVisible({ timeout: 10000 });
    await block.locator("pre").click({ force: true });
    const cm = block.locator(".cm-editor");
    await expect(cm).toBeVisible({ timeout: 10000 });
    // bug 08 (disable spellcheck in code): CM surface has spellcheck off
    await expect(cm.locator(".cm-content")).toHaveAttribute("spellcheck", "false");

    await page.keyboard.type("Z");
    const scrollBefore = await page.evaluate(() => window.scrollY);

    // Arrow-down out: keep pressing until the block reports the last CM line
    // (content shape — a bare line vs. a fence-trailing empty line — isn't
    // asserted here) and codeFocusPlugin deactivates it.
    await expect(async () => {
      await page.keyboard.press("ArrowDown");
      expect(await cm.count()).toBe(0);
    }).toPass({ timeout: 5000 });

    await expect(block.locator(".cm-editor")).toHaveCount(0);
    const pre = block.locator("pre");
    await expect(pre).toBeVisible();
    // bug 08 (disable spellcheck in code): static <pre> has spellcheck off
    await expect(pre).toHaveAttribute("spellcheck", "false");
    await expect(block).toContainText("x = 1Z");

    const scrollAfter = await page.evaluate(() => window.scrollY);
    expect(scrollAfter).toBe(scrollBefore);

    // The caret actually left the block (landed in the trailing paragraph),
    // not just cosmetically unmounted.
    const state = await readEditorState(page);
    expect(state.selHeadParent).toBe("paragraph");
  });
});

test.describe("code_block: language picker", () => {
  // @feat code-lang-picker: e2e proves hover-reveal, filter, pick, and recolor
  test("hover reveals the chrome; filtering and picking a language recolors the block", async ({
    page,
  }) => {
    // Under the `python` grammar `select 1` is an identifier + a number
    // (no keyword). Switching to `sql` should light up `select` as a keyword
    // — a clean before/after recolor signal.
    const host = await createSeededPaper(page, "```py\nselect 1\n```\n");
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const block = app.locator(".pm-code-block");
    await expect(block).toBeVisible({ timeout: 10000 });
    const btn = block.locator(".pm-code-block-lang-btn");
    await expect(btn).toHaveText("Python");

    // Chrome is edit-mode gated and hover/focus-revealed (opacity, not
    // display, so a plain toBeVisible() wouldn't catch a regression here).
    await expect(btn).toHaveCSS("opacity", "0");
    await block.hover();
    await expect(btn).toHaveCSS("opacity", "1");

    // Wait for tier-0 python highlighting to actually resolve (the number
    // token) before asserting the *absence* of a keyword token — otherwise
    // "no tok-keyword yet" would trivially pass before the grammar loads.
    await expect(block.locator("span.tok-number")).toBeVisible({ timeout: 10000 });
    await expect(block.locator("span.tok-keyword")).toHaveCount(0);

    await btn.click();
    const popup = block.locator(".pm-code-block-lang-popup");
    await expect(popup).toBeVisible();

    const input = block.locator(".pm-code-block-lang-input");
    await input.fill("sql");
    const items = block.locator(".pm-code-block-lang-item");
    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveText("SQL");
    await items.first().click();

    await expect(popup).toBeHidden();
    await expect(btn).toHaveText("SQL");
    await expect(block.locator("span.tok-keyword")).toBeVisible({ timeout: 10000 });
    await expect(block.locator("span.tok-keyword").first()).toHaveText("select");
  });
});

test.describe("viewer cost", () => {
  // @feat code-cm-focus: e2e proves a read-only view never fetches cm-core or mounts CM
  test("a locked (read-only) doc keeps tier-0 highlight but never loads cm-core or mounts CM", async ({
    page,
  }) => {
    const host = await createSeededPaper(page, "```py\ndef f():\n    return 1\n```\n", {
      actorId: "alice",
    });
    const lockResp = await page.request.post(`${BASE}/api/docs/${host.id}/lock`, {
      headers: { Cookie: cookieHeader("alice") },
    });
    expect(lockResp.status()).toBe(200);

    const requestUrls: string[] = [];
    page.on("request", (req) => requestUrls.push(req.url()));

    await page.goto(host.url);
    const app = page.locator("#app-root");
    const editor = app.locator(".ProseMirror");
    await expect(editor).toBeVisible({ timeout: 10000 });
    await expect(editor).toHaveAttribute("contenteditable", "false");

    const block = app.locator(".pm-code-block");
    await expect(block).toBeVisible({ timeout: 10000 });
    // Tier-0 static highlight still runs for viewers — it's cheap and
    // doesn't need CM at all. (Two keywords: `def` and `return`.)
    await expect(block.locator("span.tok-keyword").first()).toBeVisible({ timeout: 10000 });
    await expect(block.locator("span.tok-keyword")).toHaveCount(2);

    // Clicking the code never mounts CM in a non-editable view
    // (codeFocusPlugin's candidatePos() gates on view.editable).
    await block.locator("pre").click();
    // Give any (would-be) async mount a chance to misfire before asserting
    // its absence — mirrors codeBlockCm.test.ts's "never mounts CM in a
    // non-editable view" unit test.
    await page.waitForTimeout(500);
    await expect(block.locator(".cm-editor")).toHaveCount(0);

    expect(requestUrls.some((u) => u.includes("cm-core-"))).toBe(false);
  });
});

test.describe("sql query block: CM editing", () => {
  // @feat sql-block: e2e proves CM edit + Mod-Enter run + staleness cue
  test("editing the query in CM and Mod-Enter re-runs it; the staleness cue toggles", async ({
    page,
  }) => {
    const host = await createSeededPaper(
      page,
      "```sql db=datasette-paper-e2e-data\nselect * from vendors\n```\n",
    );
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const block = app.locator(".pm-sql-block");
    await expect(block).toBeVisible({ timeout: 10000 });
    // Auto-run on mount.
    await expect(block.locator("table")).toBeVisible({ timeout: 10000 });
    await expect(block.locator("tbody tr")).toHaveCount(10); // page 1 of 30

    // bug 09 (sql chrome not editable): results chrome isn't editable
    await expect(block.locator(".pm-sql-block-results")).toHaveAttribute(
      "contenteditable",
      "false",
    );

    // Wait for tier-0 static highlighting to settle before clicking:
    // otherwise the async decoration pass can reflow the query surface
    // right as Playwright polls its bounding box for click stability.
    await expect(block.locator("span.tok-keyword").first()).toBeVisible({ timeout: 10000 });
    await block.locator(".pm-sql-block-code").click({ force: true });
    const cm = block.locator(".cm-editor");
    await expect(cm).toBeVisible({ timeout: 10000 });
    // bug 08 (disable spellcheck in code): SQL's CM surface too
    await expect(cm.locator(".cm-content")).toHaveAttribute("spellcheck", "false");

    await expect(block.locator(".pm-sql-block-run")).not.toHaveClass(
      /pm-sql-block-run--stale/,
    );

    // Place the caret at the end of the (single-line) query before
    // appending, so the edit doesn't land mid-string.
    await page.keyboard.press("End");
    await page.keyboard.type(" where id <= 5");
    await expect(block.locator(".pm-sql-block-run")).toHaveClass(
      /pm-sql-block-run--stale/,
    );

    // CM6 resolves its "Mod" keybinding alias off the *browser's* platform
    // report (navigator.platform — see codeBlockCm.test.ts's identical
    // Mod-z check), not the test runner's host OS: Playwright's own
    // "ControlOrMeta" alias sends Meta on this (macOS) runner, which can
    // mismatch a Chromium build that reports a non-Mac platform. Ask the
    // page which one CM will actually match.
    const mac = await page.evaluate(() => /Mac|iP(hone|[oa]d)/.test(navigator.platform));
    await page.keyboard.press(mac ? "Meta+Enter" : "Control+Enter");
    await expect(block.locator(".pm-sql-block-run")).not.toHaveClass(
      /pm-sql-block-run--stale/,
    );
    await expect(block.locator("tbody tr")).toHaveCount(5);
  });
});
