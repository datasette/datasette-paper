import { test, expect } from "@playwright/test";
import {
  createPaper,
  gotoPaper,
  typeInEditor,
  expectEditorContains,
  waitForServerVersion,
} from "./helpers";

/**
 * Templates + read-only e2e coverage.
 *
 * The e2e webServer grants all four paper permissions globally and
 * runs anonymously — so every paper is created with created_by=NULL,
 * which means canManage/isOwner is always false. That gates out the
 * Lock/Unlock and Make-template owner menu items in the UI; those
 * positive paths are covered by tests/test_lock.py and
 * tests/test_templates.py. Here we cover the surface anyone with view
 * permission sees:
 *
 *   - Templates tab appears on the index page and lists templates only
 *   - Template badge appears in the doc header on a kind=template paper
 *   - The toolbar placeholder dropdown appears only on templates
 *   - Creating a paper from a template clones the template's content
 *   - Placeholders authored in a template resolve to text in the clone
 *   - The lock route gates as 403 for non-owners (proves the SQL
 *     filter is wired even when we can't drive the positive UI flow)
 */

test("Templates tab on the index lists only templates", async ({ page }) => {
  // Create a regular doc and a template; the regular doc should NOT
  // show up on the Templates tab even though both belong to the same
  // anonymous actor.
  const doc = await createPaper(page, { name: "Plain doc" });
  const tmpl = await createPaper(page, { name: "Some template", kind: "template" });

  await page.goto("/-/paper/");
  await expect(page.getByRole("heading", { name: "Papers" })).toBeVisible();

  // Default tab shows the regular doc, not the template.
  await expect(page.getByRole("link", { name: doc.name })).toBeVisible();
  await expect(page.getByRole("link", { name: tmpl.name })).toHaveCount(0);

  // Switch to Templates tab → only the template is listed.
  await page.getByRole("tab", { name: /^Templates/ }).click();
  await expect(page.getByRole("link", { name: tmpl.name })).toBeVisible();
  await expect(page.getByRole("link", { name: doc.name })).toHaveCount(0);
});

test("New paper form lets you pick a template", async ({ page }) => {
  const tmpl = await createPaper(page, { name: "Pickable", kind: "template" });

  await page.goto("/-/paper/");

  // The template-picker <select> renders with a "Blank" option plus
  // one for every template the actor can see.
  const select = page.locator("select");
  await expect(select).toBeVisible();
  // Wait for the template-list fetch to populate the dropdown.
  await expect(select.locator("option")).toContainText([
    "Blank",
    `From: ${tmpl.name}`,
  ]);
});

test("creating a paper from a template clones the content", async ({ page }) => {
  // Author content in a template.
  const tmpl = await createPaper(page, { name: "Standup", kind: "template" });
  await gotoPaper(page, tmpl.url);
  await typeInEditor(page, "Wins / Blockers / Plans");
  await expectEditorContains(page, "Wins / Blockers / Plans");
  // Make sure all keystrokes are persisted before the picker uses
  // materialize_live_doc to clone. 22 chars → version >= 22.
  await waitForServerVersion(page, tmpl.id, 22);

  // Use the index page picker to instantiate.
  await page.goto("/-/paper/");
  await page.getByPlaceholder("Paper name").fill("Today's standup");
  // The template option appears once the dropdown finishes loading.
  // <option> elements inside a closed <select> are considered hidden,
  // so attach to the parent and assert the option text appears in it.
  await expect(page.locator("select")).toContainText(`From: ${tmpl.name}`);
  await page.locator("select").selectOption({ label: `From: ${tmpl.name}` });
  await page.getByRole("button", { name: "New paper", exact: true }).click();

  // The form navigates to the new doc; the cloned content is the seed
  // snapshot so it appears immediately on the editor surface.
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });
  await expectEditorContains(page, "Wins / Blockers / Plans");
});

test("blank create still produces an empty doc", async ({ page }) => {
  await page.goto("/-/paper/");
  // Default option is "Blank"; type a name and submit.
  await page.getByPlaceholder("Paper name").fill("Untouched blank");
  await page.getByRole("button", { name: "New paper", exact: true }).click();

  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });
  // Empty document — single empty paragraph, no seed content.
  const text = (await page.locator(".ProseMirror").innerText()).trim();
  expect(text).toBe("");
});

test("template doc shows a Template badge in the doc header", async ({ page }) => {
  const tmpl = await createPaper(page, { kind: "template" });
  await gotoPaper(page, tmpl.url);

  await expect(page.locator(".template-pill")).toBeVisible();
  await expect(page.locator(".template-pill")).toHaveText("Template");
});

test("regular doc does NOT show the Template badge", async ({ page }) => {
  const doc = await createPaper(page);
  await gotoPaper(page, doc.url);

  await expect(page.locator(".template-pill")).toHaveCount(0);
});

test("placeholder dropdown appears in the toolbar only on templates", async ({
  page,
}) => {
  // Regular doc — no placeholder trigger.
  const doc = await createPaper(page);
  await gotoPaper(page, doc.url);
  await expect(page.locator(".tb-placeholder-trigger")).toHaveCount(0);

  // Template — trigger visible.
  const tmpl = await createPaper(page, { kind: "template" });
  await gotoPaper(page, tmpl.url);
  await expect(page.locator(".tb-placeholder-trigger")).toBeVisible();
});

test("inserting a placeholder in a template renders the pill", async ({ page }) => {
  const tmpl = await createPaper(page, { kind: "template" });
  await gotoPaper(page, tmpl.url);

  // Focus the editor so the placeholder lands at the current selection.
  await page.locator(".ProseMirror").click();

  // Open the placeholder dropdown and click the `today` item. The
  // dropdown lazy-loads its contents from /-/paper/api/template_params
  // when first opened.
  await page.locator(".tb-placeholder-trigger").click();
  const todayItem = page
    .locator(".tb-placeholder-menu .tb-placeholder-key", { hasText: /^today$/ })
    .first();
  await expect(todayItem).toBeVisible();
  await todayItem.click();

  // The chip renders inline in the editor surface.
  const pill = page.locator(".pm-placeholder");
  await expect(pill).toHaveCount(1);
  await expect(pill).toContainText("today");
});

test("placeholder authored in a template resolves to text in the clone", async ({
  page,
}) => {
  // Build a template that contains a placeholder for `today`.
  const tmpl = await createPaper(page, { kind: "template", name: "Standup tmpl" });
  await gotoPaper(page, tmpl.url);
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("Date: ");
  await page.locator(".tb-placeholder-trigger").click();
  await page
    .locator(".tb-placeholder-menu .tb-placeholder-key", { hasText: /^today$/ })
    .first()
    .click();

  // The placeholder is one step + "Date: " is 6 keystrokes = 7 versions
  // total (the placeholder insert lands as one step).
  await waitForServerVersion(page, tmpl.id, 7);

  // Sanity: the template editor itself still shows the chip, not the
  // resolved value — substitution only runs at create-from-template time.
  await expect(page.locator(".pm-placeholder")).toHaveCount(1);

  // Instantiate via the index picker.
  await page.goto("/-/paper/");
  await page.getByPlaceholder("Paper name").fill("Today");
  await expect(page.locator("select")).toContainText(`From: ${tmpl.name}`);
  await page.locator("select").selectOption({ label: `From: ${tmpl.name}` });
  await page.getByRole("button", { name: "New paper", exact: true }).click();

  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });
  // The clone has no placeholder chips — the substitution pass replaced
  // them with text.
  await expect(page.locator(".pm-placeholder")).toHaveCount(0);

  // The resolved text is today's UTC date. The substring "Date: " plus
  // the YYYY portion is enough to assert; we don't pin to the exact
  // date string to avoid timezone flakiness around midnight.
  const text = await page.locator(".ProseMirror").innerText();
  expect(text).toContain("Date: ");
  // Match `Date: YYYY-MM-DD`. Year window large enough to outlast any
  // clock drift but tight enough not to match arbitrary noise.
  expect(text).toMatch(/Date: 20\d{2}-\d{2}-\d{2}/);
});

test("lock route 403s for non-owners (anonymous in e2e)", async ({ page }) => {
  // The e2e harness creates papers anonymously (created_by=NULL), so
  // the inline owner check fails for the same anonymous actor and the
  // lock route returns 403. Backend tests cover the owner positive
  // path; this asserts the gate stays wired.
  const doc = await createPaper(page);
  const r = await page.request.post(`/-/paper/api/docs/${doc.id}/lock`);
  expect(r.status()).toBe(403);
});

test("make_template route 403s for non-owners (anonymous in e2e)", async ({
  page,
}) => {
  const doc = await createPaper(page);
  const r = await page.request.post(`/-/paper/api/docs/${doc.id}/make_template`);
  expect(r.status()).toBe(403);
});

test("template_params endpoint lists the built-ins with samples", async ({
  page,
}) => {
  const r = await page.request.get("/-/paper/api/template_params");
  expect(r.status()).toBe(200);
  const body = await r.json();
  const keys = (body.builtins as Array<{ key: string }>).map((b) => b.key);
  expect(keys).toEqual(
    expect.arrayContaining(["today", "now", "weekday", "actor", "year"]),
  );
});

test("kind=all listing returns both docs and templates", async ({ page }) => {
  const doc = await createPaper(page, { name: "All-doc" });
  const tmpl = await createPaper(page, { name: "All-tmpl", kind: "template" });

  const r = await page.request.get("/-/paper/api/docs?kind=all");
  expect(r.status()).toBe(200);
  const rows = (await r.json()) as Array<{ id: number; kind: string }>;
  const byId = new Map(rows.map((r) => [r.id, r.kind]));
  expect(byId.get(doc.id)).toBe("doc");
  expect(byId.get(tmpl.id)).toBe("template");
});
