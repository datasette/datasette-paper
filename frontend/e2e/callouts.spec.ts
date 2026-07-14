/**
 * E2E for the `callout` block (GitHub-style admonitions —
 * plans/callout/). Locators are scoped to `#app-root` (the debug-bar
 * "act as" <select> gotcha — see e2e/CLAUDE.md) and assertions drive the
 * document model via `readEditorState()` rather than `.innerText()`
 * (frontend/CLAUDE.md: debug editor bugs via the model, not the DOM).
 *
 * Covers:
 *   - `/callout` slash insert → callout(kind=note) with an empty title +
 *     paragraph, cursor in the title.
 *   - Typing the literal `> [!warning] ` chains the blockquote-wrap input
 *     rule with the `[!kind] ` upgrade rule.
 *   - Kind flip via the header icon button's picker (doc attr + CSS class).
 *   - The picker's "Quote" and "Remove callout" rows.
 *   - Backspace at the start of an empty title unwraps the callout.
 *   - Fold: a seeded collapsed callout renders folded; the chevron toggles
 *     the shared `collapsed` attr and round-trips the `[!KIND]-` suffix.
 *   - Markdown round-trip through the `/document` endpoint.
 *
 * @feat callout: e2e proof of slash insert, the two-rule typed-marker
 * upgrade, the kind picker (flip/quote/remove), title-backspace unwrap, and
 * the `> [!KIND] Title` markdown round-trip.
 */
import { test, expect, type Page } from "@playwright/test";
import { createPaper, gotoPaper, readEditorState } from "./helpers";

const BASE = `/-/paper`;

/** Create a paper seeded with markdown `content` (the create-from-markdown
 * API — see datasette_paper/routes/docs.py's CreateDocBody). `createPaper` in
 * helpers.ts doesn't expose `content`, so these specs post directly (mirrors
 * codemirror.spec.ts's `createSeededPaper`). */
async function createSeededPaper(
  page: Page,
  content: string,
): Promise<{ id: number; url: string }> {
  const name = `Callout-E2E-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await page.request.post(`${BASE}/api/docs`, { data: { name, content } });
  expect(r.status()).toBe(201);
  const body = await r.json();
  return { id: body.id, url: `${BASE}/doc/${body.id}` };
}

/** First (only) top-level paragraph's plain text, from a readEditorState doc. */
function textOf(node: unknown): string {
  const n = node as { content?: Array<{ text?: string }> };
  return (n.content ?? []).map((c) => c.text ?? "").join("");
}

test.describe("callout: slash insert", () => {
  test("/callout inserts callout(kind=note) with an empty title + paragraph, cursor in the title", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const editor = app.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("/callout");

    const menu = app.locator(".pm-slash-menu");
    await expect(menu).toBeVisible({ timeout: 10000 });
    await expect(menu.locator(".pm-slash-item", { hasText: "Callout" })).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(app.locator(".pm-callout")).toBeVisible({ timeout: 10000 });
    const { doc, selHeadParent } = await readEditorState(page);
    const top = (doc as { content: Array<Record<string, unknown>> }).content[0] as {
      type: string;
      attrs: { kind: string };
      content: Array<{ type: string; content?: unknown[] }>;
    };
    expect(top.type).toBe("callout");
    expect(top.attrs.kind).toBe("note");
    expect(top.content[0].type).toBe("callout_title");
    expect(top.content[0].content ?? []).toEqual([]);
    expect(top.content[1].type).toBe("paragraph");
    expect(selHeadParent).toBe("callout_title");
  });
});

test.describe("callout: typed entry", () => {
  test("typing `> [!warning] ` chains the blockquote + kind-upgrade input rules", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    await app.locator(".ProseMirror").click();
    await page.keyboard.type("> [!warning] ");

    await expect(app.locator(".pm-callout")).toBeVisible({ timeout: 10000 });
    const { doc } = await readEditorState(page);
    const top = (doc as { content: Array<{ type: string; attrs: { kind: string } }> }).content[0];
    expect(top.type).toBe("callout");
    expect(top.attrs.kind).toBe("warning");
  });
});

test.describe("callout: kind picker", () => {
  test("clicking the Caution row flips the doc attr and the CSS class", async ({ page }) => {
    const host = await createSeededPaper(page, "> [!NOTE] Title\n> Body\n");
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const callout = app.locator(".pm-callout");
    await expect(callout).toBeVisible({ timeout: 10000 });
    await expect(callout).toHaveClass(/pm-callout--note/);

    await callout.locator("button.pm-callout-kind").click();
    await expect(app.locator(".pm-callout-kind-popup--open")).toBeVisible({ timeout: 10000 });
    await app
      .locator(".pm-callout-kind-item", { hasText: "Caution" })
      .click();

    await expect(callout).toHaveClass(/pm-callout--caution/);
    const { doc } = await readEditorState(page);
    const top = (doc as { content: Array<{ attrs: { kind: string } }> }).content[0];
    expect(top.attrs.kind).toBe("caution");
  });

  test('the "Quote" row demotes the callout to a blockquote, keeping a non-empty title as the first paragraph', async ({
    page,
  }) => {
    const host = await createSeededPaper(page, "> [!NOTE] Title\n> Body\n");
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const callout = app.locator(".pm-callout");
    await expect(callout).toBeVisible({ timeout: 10000 });
    await callout.locator("button.pm-callout-kind").click();
    await expect(app.locator(".pm-callout-kind-popup--open")).toBeVisible({ timeout: 10000 });
    await app.locator(".pm-callout-kind-item", { hasText: "Quote" }).click();

    await expect(app.locator(".pm-callout")).toHaveCount(0);
    const { doc } = await readEditorState(page);
    const top = (doc as { content: Array<{ type: string; content: unknown[] }> }).content[0];
    expect(top.type).toBe("blockquote");
    expect(top.content).toHaveLength(2);
    expect(textOf(top.content[0])).toBe("Title");
    expect(textOf(top.content[1])).toBe("Body");
  });

  test('the "Remove callout" row lifts the body blocks to the top level', async ({ page }) => {
    const host = await createSeededPaper(page, "> [!NOTE]\n> Body\n");
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const callout = app.locator(".pm-callout");
    await expect(callout).toBeVisible({ timeout: 10000 });
    await callout.locator("button.pm-callout-kind").click();
    await expect(app.locator(".pm-callout-kind-popup--open")).toBeVisible({ timeout: 10000 });
    await app.locator(".pm-callout-kind-item", { hasText: "Remove callout" }).click();

    await expect(app.locator(".pm-callout")).toHaveCount(0);
    const { doc } = await readEditorState(page);
    const top = (doc as { content: Array<{ type: string }> }).content;
    expect(top).toHaveLength(1);
    expect(top[0].type).toBe("paragraph");
    expect(textOf(top[0])).toBe("Body");
  });
});

test.describe("callout: backspace unwrap", () => {
  test("Backspace at the start of an empty title unwraps the callout", async ({ page }) => {
    const host = await createSeededPaper(page, "> [!NOTE]\n> Body\n");
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const title = app.locator(".pm-callout-title");
    await expect(title).toBeVisible({ timeout: 10000 });
    // The title is empty — clicking it lands the caret at its (only) position.
    await title.click();
    await page.keyboard.press("Backspace");

    await expect(app.locator(".pm-callout")).toHaveCount(0);
    const { doc } = await readEditorState(page);
    const top = (doc as { content: Array<{ type: string }> }).content;
    expect(top).toHaveLength(1);
    expect(top[0].type).toBe("paragraph");
    expect(textOf(top[0])).toBe("Body");
  });
});

test.describe("callout: fold", () => {
  // @feat callout: e2e proof of the seeded-collapsed render + chevron
  // toggle (shared attr) + the `[!KIND]-` markdown round-trip.
  test("a seeded collapsed callout renders folded; the chevron expands it (shared attr)", async ({
    page,
  }) => {
    const host = await createSeededPaper(page, "> [!NOTE]- Title\n> Body\n");
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const callout = app.locator(".pm-callout");
    await expect(callout).toBeVisible({ timeout: 10000 });
    await expect(callout).toHaveClass(/pm-callout--collapsed/);
    // The title stays visible when folded.
    await expect(app.locator(".pm-callout-title")).toBeVisible();

    const before = await readEditorState(page);
    expect(
      (before.doc as { content: Array<{ attrs: { collapsed: boolean } }> }).content[0].attrs
        .collapsed,
    ).toBe(true);

    // The chevron expands it; the shared attr flips to false.
    await callout.locator("button.pm-callout-fold").click();
    await expect(callout).not.toHaveClass(/pm-callout--collapsed/);
    const after = await readEditorState(page);
    expect(
      (after.doc as { content: Array<{ attrs: { collapsed: boolean } }> }).content[0].attrs
        .collapsed,
    ).toBe(false);
  });

  test("collapsing via the chevron round-trips the `[!NOTE]-` fold suffix through /document", async ({
    page,
  }) => {
    const host = await createSeededPaper(page, "> [!NOTE] Title\n> Body\n");
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const callout = app.locator(".pm-callout");
    await expect(callout).toBeVisible({ timeout: 10000 });
    await expect(callout).not.toHaveClass(/pm-callout--collapsed/);

    await callout.locator("button.pm-callout-fold").click();
    await expect(callout).toHaveClass(/pm-callout--collapsed/);

    await expect
      .poll(
        async () => {
          const r = await page.request.get(`${BASE}/api/docs/${host.id}/document`);
          if (!r.ok()) return "";
          return (await r.json()).content_markdown as string;
        },
        { timeout: 10000, message: "collapsed callout markdown never persisted" },
      )
      .toContain("> [!NOTE]- Title");
  });
});

test.describe("callout: markdown round-trip", () => {
  test("a titled callout built in the editor serializes to `> [!WARNING] Title` + `> `-prefixed body", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    await app.locator(".ProseMirror").click();
    await page.keyboard.type("> [!warning] ");
    await expect(app.locator(".pm-callout")).toBeVisible({ timeout: 10000 });
    // The input rule's own cursor placement lands in the (empty) body, not the
    // title (upgradeBlockquoteInTr resolves just past the title) — click the
    // title explicitly to name it, then Enter jumps to the body (keymap:
    // enterInCalloutTitle) without splitting the callout.
    await app.locator(".pm-callout-title").click();
    await page.keyboard.type("Deploy freeze");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Hold all deploys until Monday.");

    await expect
      .poll(
        async () => {
          const r = await page.request.get(`${BASE}/api/docs/${host.id}/document`);
          if (!r.ok()) return "";
          return (await r.json()).content_markdown as string;
        },
        { timeout: 10000, message: "callout markdown never persisted" },
      )
      .toContain("> [!WARNING] Deploy freeze\n> Hold all deploys until Monday.");
  });
});
