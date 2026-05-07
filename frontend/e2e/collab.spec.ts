import { test, expect } from "@playwright/test";
import {
  createPaper,
  gotoPaper,
  typeInEditor,
  expectEditorContains,
  waitForServerVersion,
} from "./helpers";

test("creates a paper and types into it; survives reload", async ({ page }) => {
  const { id, url } = await createPaper(page);
  await gotoPaper(page, url);

  await typeInEditor(page, "hello world");
  await expectEditorContains(page, "hello world");

  // Wait for ALL keystrokes to be persisted before reloading. ProseMirror
  // batches typing into ≥1 POST /events round-trips; reload aborts any
  // in-flight requests, which would lose tail keystrokes.
  // 11 chars typed → version >= 11 server-side.
  await waitForServerVersion(page, id, 11);

  // Snapshots are client-driven; without one the doc lives entirely in
  // the step log. Reload reconstructs it from steps_tail.
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });
  await expectEditorContains(page, "hello world");
});

test("two browser contexts see each other's edits", async ({ browser }) => {
  // Two independent contexts → distinct cookies → distinct PM clientIDs.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const { url } = await createPaper(pageA);
  await gotoPaper(pageA, url);
  await gotoPaper(pageB, url);

  // Each side types something distinctive. Type slowly so steps interleave
  // and the SSE stream has work to do.
  await typeInEditor(pageA, "from-A ");
  await typeInEditor(pageB, "from-B ");

  // After convergence, both substrings appear in both editors.
  // Operational-transform rebase guarantees both edits are preserved; the
  // *order* in the final text is racey, so we don't assert on it.
  await expectEditorContains(pageA, "from-A");
  await expectEditorContains(pageA, "from-B");
  await expectEditorContains(pageB, "from-A");
  await expectEditorContains(pageB, "from-B");

  await ctxA.close();
  await ctxB.close();
});

test("paper list page shows newly-created paper", async ({ page }) => {
  const { name } = await createPaper(page);
  await page.goto("/-/paper/");
  // PaperIndex.svelte renders client-side after fetching /api/docs.
  await expect(page.getByText(name)).toBeVisible({ timeout: 10000 });
});


test("view mode disables editing and hides the toolbar", async ({ page }) => {
  const { url } = await createPaper(page);
  await gotoPaper(page, url);

  await typeInEditor(page, "hello");
  await expectEditorContains(page, "hello");

  // Toolbar visible in edit mode
  await expect(page.locator(".paper-toolbar")).toBeVisible();

  // Toggle to view mode via the doc-header pill
  await page.getByRole("button", { name: "View", exact: true }).click();

  // Toolbar should disappear; editor still visible with the existing content
  await expect(page.locator(".paper-toolbar")).toHaveCount(0);
  await expectEditorContains(page, "hello");

  // Typing should be a no-op now (the editor is contenteditable=false).
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("XYZ");
  await page.waitForTimeout(150);
  const text = await page.locator(".ProseMirror").innerText();
  expect(text).not.toContain("XYZ");

  // Toggle back; toolbar reappears and typing resumes.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".paper-toolbar")).toBeVisible();
  await typeInEditor(page, " world");
  await expectEditorContains(page, "hello world");
});

test("Copy md button writes a markdown serialization to the clipboard", async ({
  page,
}) => {
  // Stub navigator.clipboard.writeText so we don't need OS clipboard
  // permissions in headless chromium. Captured value is read back via
  // page.evaluate.
  await page.addInitScript(() => {
    (window as unknown as { __lastCopy: string }).__lastCopy = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (s: string) => {
          (window as unknown as { __lastCopy: string }).__lastCopy = s;
        },
      },
    });
  });

  const { url } = await createPaper(page);
  await gotoPaper(page, url);

  // Build a doc with a heading and a bold word so the markdown output is
  // distinctive — `# ` autoformat then `hello **world**`.
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("# Title");
  await page.keyboard.press("Enter");
  await page.keyboard.type("hello ");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyB");
  await page.keyboard.up("Control");
  await page.keyboard.type("world");

  // Open the overflow menu, then click "Copy as markdown".
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Copy as markdown", exact: true })
    .click();
  // Inline pill should flash "✓ Copied" on success.
  await expect(page.getByText("✓ Copied", { exact: true }))
    .toBeVisible({ timeout: 2000 });

  const md = await page.evaluate(
    () => (window as unknown as { __lastCopy: string }).__lastCopy,
  );
  expect(md).toContain("# Title");
  expect(md).toContain("**world**");
});

test("task list autoformat from `[ ] ` and clicking the checkbox toggles", async ({
  page,
}) => {
  const { url } = await createPaper(page);
  await gotoPaper(page, url);

  // Type `- ` to enter a bullet_list, then `[ ] ` to convert it to a
  // task_list. The `[ ] ` rule only fires inside a single-item bullet_list
  // — typing it into a bare paragraph is no longer recognized.
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("- ");
  await page.keyboard.type("[ ] buy milk");

  await expect(page.locator("li[data-task-item]")).toBeVisible();
  await expect(page.locator("li[data-task-item]")).toHaveAttribute(
    "data-checked",
    "false",
  );

  // Click the checkbox; data-checked should flip to "true" and the
  // strikethrough CSS hook should engage.
  await page.locator("li[data-task-item] > input[type=checkbox]").check();
  await expect(page.locator("li[data-task-item]")).toHaveAttribute(
    "data-checked",
    "true",
  );
});

test("Enter in a task item creates a fresh unchecked item", async ({ page }) => {
  const { url } = await createPaper(page);
  await gotoPaper(page, url);

  await page.locator(".ProseMirror").click();
  await page.keyboard.type("- ");
  await page.keyboard.type("[ ] first item");

  // Sanity: one task item, content "first item"
  await expect(page.locator("li[data-task-item]")).toHaveCount(1);

  // Enter should split into a new empty task_item
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");

  await expect(page.locator("li[data-task-item]")).toHaveCount(2);
  // Both unchecked
  const checkedAttrs = await page.locator("li[data-task-item]").evaluateAll(
    (els) => els.map((el) => (el as HTMLElement).dataset.checked),
  );
  expect(checkedAttrs).toEqual(["false", "false"]);
});

test("task list collab: checkbox toggle in tab A is visible in tab B", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const { url } = await createPaper(pageA);
  await gotoPaper(pageA, url);
  await gotoPaper(pageB, url);

  await pageA.locator(".ProseMirror").click();
  await pageA.keyboard.type("- ");
  await pageA.keyboard.type("[ ] shared");

  await expect(pageB.locator("li[data-task-item]")).toBeVisible({
    timeout: 5000,
  });

  await pageA.locator("li[data-task-item] > input[type=checkbox]").check();
  await expect(pageB.locator("li[data-task-item]")).toHaveAttribute(
    "data-checked",
    "true",
    { timeout: 5000 },
  );

  await ctxA.close();
  await ctxB.close();
});

test("remote caret appears when another browser moves selection", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const { url } = await createPaper(pageA);
  await gotoPaper(pageA, url);
  await gotoPaper(pageB, url);

  // A types some text so there's content for the caret to land in
  await typeInEditor(pageA, "hello");
  await expectEditorContains(pageA, "hello");
  await expectEditorContains(pageB, "hello");

  // A clicks at the start of the editor — moves caret. B should see
  // a remote caret decoration appear.
  await pageA.locator(".ProseMirror").click({ position: { x: 5, y: 8 } });

  await expect(pageB.locator(".remote-caret")).toBeVisible({ timeout: 5000 });

  await ctxA.close();
  await ctxB.close();
});
