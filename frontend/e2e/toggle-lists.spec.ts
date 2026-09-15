/**
 * E2E for toggle lists (collapsible `list_item`s — plans/toggle-list/).
 *
 * Locators are scoped to `#app-root` (the debug-bar "act as" <select>
 * gotcha — e2e/CLAUDE.md) and every behavioural assertion drives the
 * **document model** via `readEditorState()` rather than `.innerText()`:
 * headless Chromium silently normalises an invalid model selection to a
 * valid DOM caret, which is exactly the class of bug the caret-rescue and
 * input-rule cases can have (frontend/CLAUDE.md).
 *
 * Covers:
 *   - `/toggle` from an empty paragraph → a bullet_list holding one
 *     `kind: "toggle"` item, caret inside its paragraph.
 *   - The `[>] ` input rule on an existing bullet item (+ `undoInputRule`).
 *   - Chevron collapse: children hidden by CSS but still in the model, the
 *     summary still visible, the shared `collapsed` attr flipped.
 *   - The `/document` round-trip: `- [>] ` with **no** fold marker — the
 *     deliberate divergence from callout's `[!NOTE]-`.
 *   - Second-client sync of the shared `collapsed` attr over SSE.
 *   - A read-only viewer expanding a collapsed toggle **without** sending a
 *     step (docs/PERMISSIONS.md §6 gates SSE on `paper-view`, not
 *     `paper-edit`, so a viewer must be able to open folded content).
 *   - Caret rescue when collapsing over the selection.
 *   - A bullet, a toggle and a legacy task item in one doc.
 *
 * @feat toggle-list: e2e proof of the slash/input-rule entry points, the
 * chevron fold (shared attr + second-client sync + read-only local override
 * that sends no step), caret rescue, and the `- [>] ` markdown round-trip
 * with the fold state deliberately absent.
 */
import { test, expect, type Page } from "@playwright/test";
import { createPaper, gotoPaper, readEditorState, waitForServerVersion } from "./helpers";

const BASE = `/-/paper`;

/** Seed a paper from markdown via the create-from-markdown API. `createPaper`
 * in helpers.ts doesn't expose `content`, so (like callouts.spec.ts) we post
 * directly. */
async function createSeededPaper(
  page: Page,
  content: string,
): Promise<{ id: number; url: string }> {
  const name = `Toggle-E2E-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await page.request.post(`${BASE}/api/docs`, { data: { name, content } });
  expect(r.status()).toBe(201);
  const body = await r.json();
  return { id: body.id, url: `${BASE}/doc/${body.id}` };
}

type DocNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
};

/** Top-level children of a `readEditorState()` doc. */
function top(doc: unknown): DocNode[] {
  return (doc as { content?: DocNode[] }).content ?? [];
}

/** Concatenated text of a node's immediate inline children. */
function textOf(node: DocNode | undefined): string {
  return (node?.content ?? []).map((c) => c.text ?? "").join("");
}

/** The single list_item of the first top-level list. */
function firstItem(doc: unknown): DocNode {
  const list = top(doc)[0];
  expect(list.type).toBe("bullet_list");
  return (list.content ?? [])[0];
}

/** The `collapsed` attr of the first list's first item, read from the live
 * model (not the DOM — the fold is an attr, the CSS is a consequence). */
async function readCollapsed(page: Page): Promise<boolean> {
  const { doc } = await readEditorState(page);
  return firstItem(doc).attrs?.collapsed === true;
}

/** Server-side document version. Used to prove a read-only fold sends no
 * collab step at all. */
async function serverVersion(page: Page, docId: number): Promise<number> {
  const r = await page.request.get(`${BASE}/api/docs/${docId}`);
  expect(r.ok()).toBe(true);
  return (await r.json()).version as number;
}

/** Text of the node the selection head sits in, read from the live model.
 * Chromium's `selectionchange` is async, so a click's caret position reaches
 * PM's model *after* `click()` resolves — always poll this rather than
 * reading it once. */
async function selParentText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (window as any).__pmView;
    return view.state.doc.resolve(view.state.selection.head).parent
      .textContent as string;
  });
}

/** Focus the editor and put the caret at offset 0 of the document's first
 * paragraph, through the model. See the call site for why a click + `Home`
 * can't do this in headless Chromium. */
async function placeCaretAtFirstParagraphStart(page: Page): Promise<void> {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (window as any).__pmView;
    let start: number | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    view.state.doc.descendants((node: any, pos: number) => {
      if (start === null && node.type.name === "paragraph") start = pos + 1;
    });
    view.focus();
    // `state.selection` is a TextSelection, so its constructor hands us the
    // class without importing prosemirror-state into the page context.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const TextSelection = (view.state.selection as any).constructor;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, start)),
    );
  });
}

/** Markdown as the server currently serializes it. */
async function documentMarkdown(page: Page, docId: number): Promise<string> {
  const r = await page.request.get(`${BASE}/api/docs/${docId}/document`);
  expect(r.ok()).toBe(true);
  return (await r.json()).content_markdown as string;
}

/** A toggle with two children — the shape most of these cases start from. */
const NESTED = "- [>] Summary\n  - Child one\n  - Child two\n";

test.describe("toggle list: entry points", () => {
  test("/toggle from an empty paragraph makes a one-item toggle list with the caret inside it", async ({
    page,
  }) => {
    const host = await createPaper(page);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    await app.locator(".ProseMirror").click();
    await page.keyboard.type("/toggle");

    const menu = app.locator(".pm-slash-menu");
    await expect(menu).toBeVisible({ timeout: 10000 });
    await expect(menu.locator(".pm-slash-item", { hasText: "Toggle list" })).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(app.locator('li[data-kind="toggle"]')).toBeVisible({ timeout: 10000 });
    await expect(app.locator("button.pm-list-toggle")).toBeVisible();

    const { doc, selHeadParent } = await readEditorState(page);
    const list = top(doc)[0];
    expect(list.type).toBe("bullet_list");
    expect(list.content).toHaveLength(1);
    expect(list.content?.[0].type).toBe("list_item");
    expect(list.content?.[0].attrs?.kind).toBe("toggle");
    // The caret must be inside the item's *paragraph*, not parked on the
    // list_item boundary — headless Chromium would hide the difference.
    expect(selHeadParent).toBe("paragraph");
  });

  test("typing `[>] ` at the start of a bullet item flips it to a toggle; undoInputRule puts the literal text back", async ({
    page,
  }) => {
    const host = await createSeededPaper(page, "- Alpha\n");
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const item = app.locator(".ProseMirror li").first();
    await expect(item).toHaveText("Alpha", { timeout: 10000 });

    // Caret to column 0 of the item's summary line, then type the marker for
    // real. Two headless traps make a click + `Home` the wrong way to get
    // there (e2e/CLAUDE.md: drive the caret through the model):
    //   - `Home` routes through `lineBoundaryKeymap`'s coordinate-based
    //     `posAtCoords` walk, which headless Chromium does not resolve, so the
    //     keystroke falls through to the browser's "scroll to top".
    //   - Chromium fires `selectionchange` asynchronously, so a click's
    //     position reaches PM's *model* after `click()` has resolved — a
    //     selection set in between is overwritten by the late flush.
    // So focus + place the selection in one evaluate, then poll the model
    // until it has settled there. The typing itself is genuine, so the input
    // rule is exercised end to end.
    await placeCaretAtFirstParagraphStart(page);
    // doc > bullet_list(0) > list_item(1) > paragraph(2) → its content opens
    // at 3, i.e. column 0 of "Alpha".
    await expect.poll(async () => (await readEditorState(page)).selHead).toBe(3);
    await page.keyboard.type("[>] ");

    await expect(app.locator('li[data-kind="toggle"]')).toBeVisible({ timeout: 10000 });
    const flipped = await readEditorState(page);
    const flippedItem = firstItem(flipped.doc);
    expect(flippedItem.attrs?.kind).toBe("toggle");
    // The marker itself is consumed — it must not survive as text.
    expect(textOf(flippedItem.content?.[0])).toBe("Alpha");

    // The rule ran as a single transaction, so `undoInputRule` (bound to
    // Backspace by prosemirror-example-setup's buildKeymap) reverts it in one
    // go to what was literally typed. Pinned in a unit test too
    // (collab.test.ts "one undo puts the literal `[>] ` text back").
    await page.keyboard.press("Backspace");
    await expect(app.locator('li[data-kind="toggle"]')).toHaveCount(0);
    const undone = await readEditorState(page);
    const undoneItem = firstItem(undone.doc);
    expect(undoneItem.attrs?.kind).toBe("bullet");
    expect(textOf(undoneItem.content?.[0])).toBe("[>] Alpha");
  });
});

test.describe("toggle list: fold", () => {
  test("the chevron collapses: children hidden by CSS but still in the model, summary still visible", async ({
    page,
  }) => {
    const host = await createSeededPaper(page, NESTED);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const item = app.locator('li[data-kind="toggle"]');
    await expect(item).toBeVisible({ timeout: 10000 });
    const summary = item.locator("> .pm-list-item-content > p").first();
    const children = item.locator("> .pm-list-item-content > ul");
    await expect(children).toBeVisible();
    expect(await readCollapsed(page)).toBe(false);

    await item.locator("button.pm-list-toggle").click();

    await expect(item).toHaveAttribute("data-collapsed", "true");
    await expect(item).toHaveClass(/pm-list-item--collapsed/);
    // Children hide via CSS only — they are never detached, so positions and
    // selection stay sane.
    await expect(children).toBeHidden();
    await expect(summary).toBeVisible();

    const { doc } = await readEditorState(page);
    const toggled = firstItem(doc);
    expect(toggled.attrs?.collapsed).toBe(true);
    // Still two children in the document model.
    const nested = toggled.content?.[1];
    expect(nested?.type).toBe("bullet_list");
    expect(nested?.content).toHaveLength(2);
    expect(textOf(nested?.content?.[0].content?.[0])).toBe("Child one");

    // And it expands again, back onto the shared attr.
    await item.locator("button.pm-list-toggle").click();
    await expect(item).not.toHaveAttribute("data-collapsed", "true");
    await expect(children).toBeVisible();
    expect(await readCollapsed(page)).toBe(false);
  });

  test("collapse round-trips through /document as `- [>] ` with NO fold marker", async ({
    page,
  }) => {
    const host = await createSeededPaper(page, NESTED);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const item = app.locator('li[data-kind="toggle"]');
    await expect(item).toBeVisible({ timeout: 10000 });

    await item.locator("button.pm-list-toggle").click();
    await expect(item).toHaveAttribute("data-collapsed", "true");
    // The collapse is a real collab step; wait for it to land before reading
    // the server's serialization (the markdown is identical either way, so
    // polling the markdown itself could not tell us the step had arrived).
    await waitForServerVersion(page, host.id, 1);

    const md = await documentMarkdown(page, host.id);
    // Unlike callout's Obsidian-compatible `[!NOTE]-`, the fold is
    // presentation and is deliberately not serialized: the summary line is
    // exactly `- [>] Summary`, with nothing appended.
    expect(md).toMatch(/^- \[>\] Summary$/m);
    expect(md).toContain("  - Child one\n");
    expect(md).not.toMatch(/\[>\][-+]/);
    expect(md).not.toContain("collapsed");
  });

  test("the caret is rescued out of a subtree that collapse is about to hide", async ({
    page,
  }) => {
    const host = await createSeededPaper(page, NESTED);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const item = app.locator('li[data-kind="toggle"]');
    await expect(item).toBeVisible({ timeout: 10000 });

    // Put the caret inside the *second* child — the deepest thing the fold
    // hides. `selectionchange` is async in Chromium, so poll the model until
    // the click has actually reached it; reading once sees the pre-click
    // selection (doc start) and the test would assert nothing.
    await item.locator("> .pm-list-item-content > ul > li > p").nth(1).click();
    await expect.poll(() => selParentText(page), { timeout: 10000 }).toBe("Child two");
    expect((await readEditorState(page)).selHeadParent).toBe("paragraph");

    await item.locator("button.pm-list-toggle").click();
    await expect(item).toHaveAttribute("data-collapsed", "true");

    // The selection must have moved onto the item's own (still visible)
    // summary paragraph rather than staying in `display: none` content.
    const after = await readEditorState(page);
    expect(after.selHeadParent).toBe("paragraph");
    expect(await selParentText(page)).toBe("Summary");
  });
});

test.describe("toggle list: collaboration", () => {
  test("client A's collapse folds client B's view (the point of a synced attr)", async ({
    browser,
  }) => {
    // Two independent contexts → distinct cookies → distinct PM clientIDs.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      const host = await createSeededPaper(pageA, NESTED);
      await gotoPaper(pageA, host.url);
      await gotoPaper(pageB, host.url);

      const itemA = pageA.locator("#app-root").locator('li[data-kind="toggle"]');
      const itemB = pageB.locator("#app-root").locator('li[data-kind="toggle"]');
      await expect(itemA).toBeVisible({ timeout: 10000 });
      await expect(itemB).toBeVisible({ timeout: 10000 });
      expect(await readCollapsed(pageB)).toBe(false);

      await itemA.locator("button.pm-list-toggle").click();
      await expect(itemA).toHaveAttribute("data-collapsed", "true");

      // B receives the attr over SSE and folds.
      await expect(itemB).toHaveAttribute("data-collapsed", "true", { timeout: 10000 });
      await expect(itemB.locator("> .pm-list-item-content > ul")).toBeHidden();
      await expect.poll(() => readCollapsed(pageB), { timeout: 10000 }).toBe(true);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

test.describe("toggle list: read-only viewer", () => {
  test("a viewer expands a collapsed toggle locally without sending a step", async ({
    page,
  }) => {
    const host = await createSeededPaper(page, NESTED);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    const item = app.locator('li[data-kind="toggle"]');
    await expect(item).toBeVisible({ timeout: 10000 });

    // Collapse it as an editor and let the step land. `collapsed` is not
    // serialized, so markdown can't seed a folded toggle — the only way to
    // hand a reader one is for an editor to have folded it.
    await item.locator("button.pm-list-toggle").click();
    await expect(item).toHaveAttribute("data-collapsed", "true");
    await waitForServerVersion(page, host.id, 1);

    // Re-bootstrap from the server: the seeded-collapsed toggle renders folded.
    await page.reload();
    const reloaded = app.locator('li[data-kind="toggle"]');
    await expect(reloaded).toBeVisible({ timeout: 10000 });
    await expect(reloaded).toHaveAttribute("data-collapsed", "true");
    await expect(reloaded.locator("> .pm-list-item-content > ul")).toBeHidden();

    // Drop to a read-only view. The e2e actor keeps paper-edit globally, so
    // this is the app's editable-UI gate rather than a permission denial —
    // it drives the same `view.editable === false` branch the NodeView reads.
    await app.getByRole("button", { name: "View", exact: true }).click();
    await expect(page.locator(".paper-toolbar")).toHaveCount(0);
    await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");

    const versionBefore = await serverVersion(page, host.id);

    // The viewer opens the toggle. SSE is gated on `paper-view`, not
    // `paper-edit` (docs/PERMISSIONS.md §6), so a reader handed a collapsed
    // toggle must still be able to read its contents.
    await reloaded.locator("button.pm-list-toggle").click();
    await expect(reloaded).not.toHaveAttribute("data-collapsed", "true");
    await expect(reloaded.locator("> .pm-list-item-content > ul")).toBeVisible();

    // …but purely locally: the shared attr is untouched and no step was sent.
    expect(await readCollapsed(page)).toBe(true);
    await page.waitForTimeout(500);
    expect(await serverVersion(page, host.id)).toBe(versionBefore);
    expect(await readCollapsed(page)).toBe(true);
  });
});

test.describe("toggle list: mixed content", () => {
  // A bullet and a toggle share a `bullet_list`; a task item cannot be their
  // literal sibling (the schema is `bullet_list = list_item+` /
  // `task_list = task_item+`, and the markdown parser coerces every item of a
  // checkbox-bearing list to `task_item`), so the legacy task list is the
  // adjacent block instead.
  test("a bullet, a toggle and a legacy task item coexist in one doc and round-trip", async ({
    page,
  }) => {
    const source = "- Plain bullet\n- [>] Toggle summary\n\nSeparator\n\n- [ ] Task item\n";
    const host = await createSeededPaper(page, source);
    await gotoPaper(page, host.url);

    const app = page.locator("#app-root");
    await expect(app.locator('li[data-kind="toggle"]')).toBeVisible({ timeout: 10000 });

    const { doc } = await readEditorState(page);
    const blocks = top(doc);
    expect(blocks.map((b) => b.type)).toEqual([
      "bullet_list",
      "paragraph",
      "task_list",
    ]);

    const [plain, toggle] = blocks[0].content ?? [];
    expect(plain.type).toBe("list_item");
    expect(plain.attrs?.kind).toBe("bullet");
    expect(textOf(plain.content?.[0])).toBe("Plain bullet");
    expect(toggle.type).toBe("list_item");
    expect(toggle.attrs?.kind).toBe("toggle");
    expect(textOf(toggle.content?.[0])).toBe("Toggle summary");

    const task = (blocks[2].content ?? [])[0];
    expect(task.type).toBe("task_item");
    expect(task.attrs?.checked).toBe(false);
    expect(textOf(task.content?.[0])).toBe("Task item");

    // Only the toggle gets a chevron: the plain bullet keeps the bare-<li>
    // fast path and the task item keeps its checkbox.
    await expect(app.locator("button.pm-list-toggle")).toHaveCount(1);
    await expect(app.locator('.ProseMirror input[type="checkbox"]')).toHaveCount(1);

    expect(await documentMarkdown(page, host.id)).toBe(source);
  });
});
