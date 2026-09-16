/**
 * E2E for the selection bubble (`frontend/src/lib/selectionBubble.ts`) — the
 * docked toolbar's floating twin: select text and the formatting controls come
 * to the selection. Covers the two show triggers (a settled mouse selection and
 * right-click), the controls that differ from the strip only in where they sit,
 * the suppression matrix's user-visible cases, and the collab guarantee that a
 * remote delete can't strand an open bubble.
 *
 * Locators are scoped to `#app-root` — the debug bar injects an "act as"
 * <select> outside it (see e2e/CLAUDE.md). Bubble controls are scoped one level
 * further, to `.pm-selection-bubble`: the strip and the bubble build buttons
 * with the *same* accessible names, so an `#app-root`-wide role query matches
 * two elements whenever the bubble is up. (`helpers.ts`'s `openTextMenu` /
 * `openLinkMenu` are scoped to `.paper-toolbar` for the mirror-image reason.)
 *
 * The truth table itself — every branch of `shouldShowBubble`, the anchor
 * mapping, the Escape ladder — is unit-tested in
 * `src/lib/__tests__/selectionBubble.test.ts`; this file proves the gestures
 * and the wiring in a real browser.
 */
import { test, expect, type Page } from "@playwright/test";
import { cookieHeader, gotoPaper, readEditorState } from "./helpers";

const BASE = `/-/paper`;

/** A paper seeded from markdown (POST /api/docs with `content`), as
 * `codemirror.spec.ts` / `escape-coexistence.spec.ts` do — much faster than
 * typing the fixture in. */
async function createSeededPaper(
  page: Page,
  content: string,
  opts: { actorId?: string } = {},
): Promise<{ id: number; url: string }> {
  const name = `SB-E2E-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestOpts: Parameters<typeof page.request.post>[1] = {
    data: { name, content },
  };
  if (opts.actorId) requestOpts.headers = { Cookie: cookieHeader(opts.actorId) };
  const r = await page.request.post(`${BASE}/api/docs`, requestOpts);
  expect(r.status()).toBe(201);
  const body = await r.json();
  return { id: body.id, url: `${BASE}/doc/${body.id}` };
}

/** A long line, so a word picked out of the middle is nowhere near the host
 * edges the bubble clamps against. */
const PROSE =
  "Alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima.\n";

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  cx: number;
  cy: number;
}

/** The viewport rect of the first occurrence of `word` in the rendered doc. */
async function wordRect(page: Page, word: string): Promise<Rect> {
  return page.evaluate((w) => {
    const root = document.querySelector("#app-root .ProseMirror");
    if (!root) throw new Error("no .ProseMirror");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const i = (node.textContent ?? "").indexOf(w);
      if (i === -1) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + w.length);
      const r = range.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
      };
    }
    throw new Error(`word not found in the editor: ${w}`);
  }, word);
}

/** Double-click a word — a real settle gesture: the browser selects the word,
 * PM turns it into a TextSelection, and `mouseup` opens the bubble on the next
 * tick. Returns the word's rect so a caller can check the bubble's anchoring. */
async function selectWord(page: Page, word: string): Promise<Rect> {
  const r = await wordRect(page, word);
  await page.mouse.dblclick(r.cx, r.cy);
  return r;
}

/** Wait for the gesture to reach the *model*. PM syncs a browser selection
 * into its own state through the DOM observer's flush, which is a tick or two
 * behind the mouse event — a bare read races it under suite load. */
async function expectSelectionNonEmpty(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readEditorState(page)).selEmpty, {
      timeout: 5000,
      message: "the selection gesture never reached the document model",
    })
    .toBe(false);
}

/** Record `defaultPrevented` for every contextmenu event that reaches the
 * document. The bubble's handler sits on `view.dom` and runs first, so a
 * bubble-phase listener here reads its verdict — which is how "the native menu
 * was suppressed" is observable at all (Playwright can't see the OS menu). */
async function spyOnContextMenu(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __ctxPrevented: boolean[] };
    w.__ctxPrevented = [];
    document.addEventListener("contextmenu", (e) => {
      w.__ctxPrevented.push(e.defaultPrevented);
    });
  });
}

const ctxSpy = (page: Page): Promise<boolean[]> =>
  page.evaluate(
    () => (window as unknown as { __ctxPrevented: boolean[] }).__ctxPrevented,
  );

// @feat selection-bubble: e2e — the show/hide gestures, the controls and the
// suppression matrix in a real browser, plus the collab anti-stranding case
test.describe("selection bubble", () => {
  test("a settled selection opens it, centred over the selected text", async ({
    page,
  }) => {
    await gotoPaper(page, (await createSeededPaper(page, PROSE)).url);
    const app = page.locator("#app-root");
    const bubble = app.locator(".pm-selection-bubble");
    await expect(bubble).toBeHidden();

    const word = await selectWord(page, "hotel");
    await expect(bubble).toBeVisible();

    const box = (await bubble.boundingBox())!;
    // Not clamped against either host edge — otherwise "centred" is untestable.
    expect(box.x).toBeGreaterThan(0);
    expect(Math.abs(box.x + box.width / 2 - word.cx)).toBeLessThan(14);
    // Vertically it takes the flipped-below branch here: the seeded paragraph
    // is the first line of the doc, so sitting above it would collide with the
    // sticky toolbar (the `pm-tt-below` idiom from tableInsertTooltip.ts).
    await expect(bubble).toHaveClass(/pm-sb-below/);
    expect(box.y).toBeGreaterThanOrEqual(word.bottom - 1);
  });

  test("B applies strong and leaves the selection intact", async ({ page }) => {
    await gotoPaper(page, (await createSeededPaper(page, PROSE)).url);
    const app = page.locator("#app-root");
    const bubble = app.locator(".pm-selection-bubble");

    await selectWord(page, "charlie");
    await expect(bubble).toBeVisible();
    await bubble.getByRole("button", { name: "Bold", exact: true }).click();

    await expect(app.locator(".ProseMirror strong")).toHaveText("charlie");
    // The bubble survives its own command (the anchor maps across the step) and
    // the range it formatted is still selected, so a second toggle is possible.
    await expect(bubble).toBeVisible();
    await expect(
      bubble.getByRole("button", { name: "Bold", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expectSelectionNonEmpty(page);
  });

  test("the highlight dot applies a slot colour and the remove swatch clears it", async ({
    page,
  }) => {
    await gotoPaper(page, (await createSeededPaper(page, PROSE)).url);
    const app = page.locator("#app-root");
    const bubble = app.locator(".pm-selection-bubble");

    await selectWord(page, "charlie");
    await expect(bubble).toBeVisible();
    await bubble.getByRole("button", { name: "Highlight", exact: true }).click();
    await bubble.getByLabel("Highlight color 2").click();

    const mark = app.locator('.ProseMirror mark.pp-hl[data-color="hl2"]');
    await expect(mark).toHaveText("charlie");
    // The trigger glyph *is* the state — it follows the mark under the anchor.
    await expect(bubble.locator(".tb-hl-trigger-dot")).toHaveAttribute(
      "data-color",
      "hl2",
    );

    await bubble.getByRole("button", { name: "Highlight", exact: true }).click();
    await bubble.getByLabel("Remove highlight").click();
    await expect(app.locator(".ProseMirror mark.pp-hl")).toHaveCount(0);
    await expect(bubble.locator(".tb-hl-trigger-dot")).toHaveClass(/tb-hl-none/);
  });

  test("Text ▾ turns the block into a heading and the trigger label follows", async ({
    page,
  }) => {
    await gotoPaper(page, (await createSeededPaper(page, PROSE)).url);
    const app = page.locator("#app-root");
    const bubble = app.locator(".pm-selection-bubble");

    await selectWord(page, "charlie");
    await expect(bubble).toBeVisible();
    await expect(bubble.locator(".tb-trigger-label")).toHaveText("Text");

    await bubble.getByRole("button", { name: "Turn into", exact: true }).click();
    // The row's accessible name carries its shortcut hint, hence the regex.
    await bubble.getByRole("menuitem", { name: /^Heading 2/ }).click();

    await expect(app.locator(".ProseMirror h2")).toContainText("charlie");
    await expect(bubble.locator(".tb-trigger-label")).toHaveText("H2");
  });

  test("right-click over a selection opens the bubble and suppresses the native menu", async ({
    page,
  }) => {
    await spyOnContextMenu(page);
    await gotoPaper(page, (await createSeededPaper(page, PROSE)).url);
    const app = page.locator("#app-root");
    const bubble = app.locator(".pm-selection-bubble");

    const word = await selectWord(page, "charlie");
    await expect(bubble).toBeVisible();
    // Dismiss, then re-summon with the right button — the recoverability the
    // two-trigger design (design.md §Triggers) exists for.
    await page.keyboard.press("Escape");
    await expect(bubble).toBeHidden();

    await page.mouse.click(word.cx, word.cy, { button: "right" });
    await expect(bubble).toBeVisible();
    expect(await ctxSpy(page)).toEqual([true]);
  });

  test("right-click over empty space leaves the native menu alone", async ({
    page,
  }) => {
    await spyOnContextMenu(page);
    await gotoPaper(page, (await createSeededPaper(page, PROSE)).url);
    const app = page.locator("#app-root");
    const bubble = app.locator(".pm-selection-bubble");

    // Well below the single seeded line, but still inside the editor's 60vh
    // min-height — a collapsed cursor, which the bubble declines to claim.
    const editor = (await app.locator(".ProseMirror").boundingBox())!;
    const x = editor.x + editor.width / 2;
    const y = editor.y + editor.height - 20;
    await page.mouse.click(x, y);
    await page.mouse.click(x, y, { button: "right" });

    expect(await ctxSpy(page)).toEqual([false]);
    await expect(bubble).toBeHidden();
  });

  test("no bubble for a selection inside a code block", async ({ page }) => {
    await gotoPaper(
      page,
      (await createSeededPaper(page, "Intro.\n\n```js\nconst answer = 42;\n```\n"))
        .url,
    );
    const app = page.locator("#app-root");
    const bubble = app.locator(".pm-selection-bubble");
    const block = app.locator(".pm-code-block");
    await expect(block).toBeVisible({ timeout: 10000 });
    // Wait for the tier-0 decoration pass to settle — it reflows the block and
    // otherwise races the drag below (codemirror.spec.ts hits the same thing).
    await expect(block.locator("span.tok-number")).toBeVisible({ timeout: 10000 });

    // Drag across `answer`. A CodeMirror mount is queued the moment the
    // selection lands inside the block, but it needs a dynamic import to
    // resolve, so at the `mouseup` settle tick this is still a plain PM
    // TextSelection inside a `code_block` — the branch being suppressed.
    const word = await wordRect(page, "answer");
    await page.mouse.move(word.left + 1, word.cy);
    await page.mouse.down();
    await page.mouse.move(word.right - 1, word.cy, { steps: 4 });
    await page.mouse.up();

    await expect(bubble).toBeHidden();
    // …and still hidden once CodeMirror has taken the surface over.
    await expect(block.locator(".cm-editor")).toBeVisible({ timeout: 10000 });
    await expect(bubble).toBeHidden();
  });

  test("no bubble inside a table cell; the table tooltip still owns that UI", async ({
    page,
  }) => {
    await gotoPaper(
      page,
      (
        await createSeededPaper(
          page,
          "| Item | Owner |\n| --- | --- |\n| Design sprint | alice |\n",
        )
      ).url,
    );
    const app = page.locator("#app-root");
    const bubble = app.locator(".pm-selection-bubble");
    await expect(app.locator(".ProseMirror table")).toBeVisible();

    await selectWord(page, "sprint");
    await expectSelectionNonEmpty(page);
    await expect(bubble).toBeHidden();
    // `tableInsertTooltip.ts` owns *all* in-table chrome — it is what appears
    // instead (toolbar-redesign/design.md's "zero in-table actions" invariant).
    await expect(app.locator(".pm-table-tooltip-root")).toBeVisible();
  });

  test("no bubble on a read-only doc", async ({ page }) => {
    // A locked doc is the reachable read-only state in this harness: the
    // webServer grants paper-view + paper-edit globally, so edit is removed
    // per-doc by its owner instead (the `locked` deny — docs/PERMISSIONS.md).
    const host = await createSeededPaper(page, PROSE, { actorId: "alice" });
    const lock = await page.request.post(`${BASE}/api/docs/${host.id}/lock`, {
      headers: { Cookie: cookieHeader("alice") },
    });
    expect(lock.status()).toBe(200);

    await page.goto(host.url);
    const app = page.locator("#app-root");
    const editor = app.locator(".ProseMirror");
    await expect(editor).toBeVisible({ timeout: 10000 });
    await expect(editor).toHaveAttribute("contenteditable", "false");

    await selectWord(page, "charlie");
    // The browser still selects in a non-editable view (PM just never adopts
    // it), so check the DOM selection — otherwise a gesture that silently did
    // nothing would make the assertion below pass for the wrong reason.
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain(
      "charlie",
    );
    await expect(app.locator(".pm-selection-bubble")).toBeHidden();
  });

  test("typing hides an open bubble", async ({ page }) => {
    await gotoPaper(page, (await createSeededPaper(page, PROSE)).url);
    const app = page.locator("#app-root");
    const bubble = app.locator(".pm-selection-bubble");

    await selectWord(page, "charlie");
    await expect(bubble).toBeVisible();
    await page.keyboard.type("Z");
    await expect(bubble).toBeHidden();
    await expect(app.locator(".ProseMirror p").first()).toContainText(
      "Alpha bravo Z delta",
    );
  });

  test("Escape closes it, and a second Escape does not bring it back", async ({
    page,
  }) => {
    await gotoPaper(page, (await createSeededPaper(page, PROSE)).url);
    const app = page.locator("#app-root");
    const bubble = app.locator(".pm-selection-bubble");

    await selectWord(page, "charlie");
    await expect(bubble).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bubble).toBeHidden();

    // The second press falls through the bubble's keymap (it consumes nothing
    // once closed) to baseKeymap's selectParentNode. What matters here is only
    // that the bubble stays shut: nothing re-summons it but a fresh trigger.
    await page.keyboard.press("Escape");
    await expect(bubble).toBeHidden();
  });

  test("a remote delete of the anchored span dismisses the bubble", async ({
    browser,
  }) => {
    // The `linkEditKey`-shaped guarantee (#84, design.md §Anchor state and
    // collab): the bubble anchors to plugin-state positions mapped through
    // every step, so a collaborator deleting the span drops the anchor instead
    // of stranding chrome over text that no longer exists. Lives here rather
    // than in collab.spec.ts — it's a bubble invariant that happens to need two
    // clients, not a claim about the SSE protocol.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      const host = await createSeededPaper(pageA, PROSE);
      await gotoPaper(pageA, host.url);
      await gotoPaper(pageB, host.url);

      const bubbleA = pageA.locator("#app-root .pm-selection-bubble");
      await selectWord(pageA, "charlie");
      await expect(bubbleA).toBeVisible();

      await pageB.evaluate((word) => {
        const view = (window as unknown as { __pmView: import("prosemirror-view").EditorView })
          .__pmView;
        let span: { from: number; to: number } | null = null;
        view.state.doc.descendants((node, pos) => {
          if (span || !node.isText) return;
          const i = (node.text ?? "").indexOf(word);
          if (i !== -1) span = { from: pos + i, to: pos + i + word.length };
        });
        if (!span) throw new Error(`word not in B's doc: ${word}`);
        view.dispatch(view.state.tr.delete(span.from, span.to));
      }, "charlie");

      await expect(bubbleA).toBeHidden({ timeout: 10000 });
      // Prove the hide came from the arriving step, not from A losing focus
      // (blur closes the bubble too, which would make this pass vacuously).
      const state = await pageA.evaluate(() => ({
        text: (window as unknown as { __pmView: import("prosemirror-view").EditorView })
          .__pmView.state.doc.textContent,
        focused: document.activeElement?.classList.contains("ProseMirror") ?? false,
      }));
      expect(state.text).not.toContain("charlie");
      expect(state.focused).toBe(true);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

test.describe("selection bubble on a phone", () => {
  // Viewport only — no `isMobile` / `hasTouch`. The gate is literally
  // `matchMedia("(max-width: 640px)")`, and touch emulation turns the
  // double-click below into a gesture Chromium doesn't word-select with.
  test.use({ viewport: { width: 375, height: 667 } });

  test("stays shut below 640px; the docked strip is still there", async ({
    page,
  }) => {
    await gotoPaper(page, (await createSeededPaper(page, PROSE)).url);
    const app = page.locator("#app-root");

    await selectWord(page, "charlie");
    await expectSelectionNonEmpty(page);
    await expect(app.locator(".pm-selection-bubble")).toBeHidden();
    await expect(app.locator(".paper-toolbar")).toBeVisible();
  });
});
