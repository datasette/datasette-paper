/**
 * E2E for the tables feature: insert a table from the toolbar, fill cells,
 * give it a name, and assert the new `/-/paper/api/docs/{id}/tables/{name}`
 * endpoint reflects the doc.
 */
import { test, expect } from "@playwright/test";
import {
  createPaper,
  gotoPaper,
  waitForServerVersion,
} from "./helpers";

const BASE = `/-/paper`;

/** Insert a table by clicking the toolbar's Insert-table button. The
 * button is gated by canInsertTable() — enabled only when the cursor
 * sits on an empty top-level paragraph, which is the default state of
 * a freshly-created paper. */
async function insertTableViaToolbar(page: import("@playwright/test").Page) {
  const btn = page.getByRole("button", {
    name: "Insert table (empty paragraphs only)",
  });
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(page.locator(".ProseMirror table")).toBeVisible();
}

test("insert table via toolbar, fill cells, name it, fetch via API", async ({ page }) => {
  const { id, url } = await createPaper(page);
  await gotoPaper(page, url);

  await insertTableViaToolbar(page);

  // The default table is 3x3 with the first row as headers.
  await expect(page.locator(".ProseMirror table")).toBeVisible();
  const headers = page.locator(".ProseMirror table th");
  await expect(headers).toHaveCount(3);

  // Fill the header row + one body row. Click each cell, type, Tab to
  // advance — Tab is bound to goToNextCell inside tables.
  const firstHeader = headers.first();
  await firstHeader.click();
  await page.keyboard.type("item");
  await page.keyboard.press("Tab");
  await page.keyboard.type("cost");
  await page.keyboard.press("Tab");
  await page.keyboard.type("qty");
  await page.keyboard.press("Tab");
  await page.keyboard.type("coffee");
  await page.keyboard.press("Tab");
  await page.keyboard.type("4");
  await page.keyboard.press("Tab");
  await page.keyboard.type("2");

  // The Name input lives in the in-table tooltip bar. Commits on Enter
  // or blur — explicit Enter keeps the test deterministic.
  const nameInput = page.locator("input.pm-tt-name");
  await expect(nameInput).toBeVisible();
  await nameInput.fill("budget");
  await nameInput.press("Enter");

  // Wait for the named table to appear on the server. setNodeMarkup is
  // the last dispatch, so version-counting alone is brittle: we'd hit
  // version-floor well before the name-attr step has been flushed.
  // Poll the lookup endpoint directly instead.
  await expect
    .poll(
      async () =>
        (
          await page.request.get(`${BASE}/api/docs/${id}/tables/budget`)
        ).status(),
      {
        timeout: 10000,
        message: "table 'budget' never appeared on the server",
      },
    )
    .toBe(200);

  const resp = await page.request.get(
    `${BASE}/api/docs/${id}/tables/budget`,
  );
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body.name).toBe("budget");
  expect(body.header).toEqual(["item", "cost", "qty"]);
  // Default table is 3 rows × 3 cols → header + 2 body rows. We fill the
  // first body row only; the second stays blank.
  expect(body.rows).toEqual([
    ["coffee", "4", "2"],
    ["", "", ""],
  ]);
  expect(body.duplicates).toBe(1);

  // Listing endpoint shows the named table.
  const listResp = await page.request.get(`${BASE}/api/docs/${id}/tables`);
  expect(listResp.status()).toBe(200);
  const listBody = await listResp.json();
  expect(listBody.tables).toHaveLength(1);
  expect(listBody.tables[0].name).toBe("budget");
  expect(listBody.tables[0].columns).toEqual(["item", "cost", "qty"]);
  expect(listBody.tables[0].row_count).toBe(2);
});

test("API button opens the table's URL in a new tab once a name is set", async ({
  page,
  context,
}) => {
  const { id, url } = await createPaper(page);
  await gotoPaper(page, url);
  await insertTableViaToolbar(page);

  const apiBtn = page.getByRole("button", {
    name: "Open this table's API URL in a new tab",
  });
  // No name yet → disabled.
  await expect(apiBtn).toBeDisabled();

  // Set a name, commit on Enter.
  const nameInput = page.locator("input.pm-tt-name");
  await nameInput.fill("budget");
  await nameInput.press("Enter");

  // After commit the button enables.
  await expect(apiBtn).toBeEnabled();

  // Click → opens a new tab pointing at the API URL. Capture via the
  // context's "page" event.
  const popupPromise = context.waitForEvent("page");
  await apiBtn.click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  expect(popup.url()).toContain(`/-/paper/api/docs/${id}/tables/budget`);
  await popup.close();
});

test("Insert-table toolbar button disables when the paragraph is non-empty", async ({ page }) => {
  const { url } = await createPaper(page);
  await gotoPaper(page, url);

  const btn = page.getByRole("button", {
    name: "Insert table (empty paragraphs only)",
  });
  // Empty paragraph → enabled.
  await expect(btn).toBeEnabled();

  // Type something — the paragraph is no longer empty, so button disables.
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("hello");
  await expect(btn).toBeDisabled();

  // Backspace it back to empty → re-enabled.
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(btn).toBeEnabled();
});

test("Tab in the bottom-right cell appends a new row", async ({ page }) => {
  const { url } = await createPaper(page);
  await gotoPaper(page, url);

  await insertTableViaToolbar(page);
  // Default 3×3 table — 1 header row + 2 body rows. Three rows total.
  await expect(page.locator(".ProseMirror table tr")).toHaveCount(3);

  // Click into the last (bottom-right) td, then press Tab → should
  // append a 4th row and put the caret in its first cell.
  const lastCell = page.locator(".ProseMirror table td").last();
  await lastCell.click();
  await page.keyboard.press("Tab");

  await expect(page.locator(".ProseMirror table tr")).toHaveCount(4);
  // Type something to confirm the caret is inside the new row's first cell.
  await page.keyboard.type("new row");
  // Find the row we just created (the last <tr>) and check its first cell.
  const newFirstCell = page
    .locator(".ProseMirror table tr")
    .last()
    .locator("td")
    .first();
  await expect(newFirstCell).toContainText("new row");
});

test("drag a body row by its grip handle to reorder", async ({ page }) => {
  const { id, url } = await createPaper(page);
  await gotoPaper(page, url);
  await insertTableViaToolbar(page);

  // Default 3×3 table — header row + two body rows. Fill the body rows
  // with distinct values so the order is unambiguous after the drag.
  const headers = page.locator(".ProseMirror table th");
  await headers.first().click();
  // Header row.
  await page.keyboard.type("col");
  await page.keyboard.press("Tab");
  await page.keyboard.type("c2");
  await page.keyboard.press("Tab");
  await page.keyboard.type("c3");
  // First body row.
  await page.keyboard.press("Tab");
  await page.keyboard.type("alpha");
  await page.keyboard.press("Tab");
  await page.keyboard.type("a2");
  await page.keyboard.press("Tab");
  await page.keyboard.type("a3");
  // Second body row.
  await page.keyboard.press("Tab");
  await page.keyboard.type("beta");
  await page.keyboard.press("Tab");
  await page.keyboard.type("b2");
  await page.keyboard.press("Tab");
  await page.keyboard.type("b3");

  // Name the table so we can verify the row order via the API.
  const nameInput = page.locator("input.pm-tt-name");
  await nameInput.fill("rows");
  await nameInput.press("Enter");

  // Hover over the first body row (alpha) to reveal the grip handle.
  // Body rows are tr index 1 and 2 (0 is the header).
  const alphaRow = page.locator(".ProseMirror table tr").nth(1);
  const betaRow = page.locator(".ProseMirror table tr").nth(2);
  // Hover triggers the mousemove listener that places the handle.
  await alphaRow.hover();
  const handle = page.locator(".pm-row-drag-handle");
  await expect(handle).toBeVisible();

  // Drag alpha row's handle past beta's bottom edge so the drop boundary
  // lands below beta. Playwright's mouse.down/move/up dispatches both
  // mouse and pointer events, so the plugin's pointer listeners fire.
  const handleBox = await handle.boundingBox();
  const betaBox = await betaRow.boundingBox();
  if (!handleBox || !betaBox) throw new Error("missing bounding boxes");
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  // Move in two steps so the plugin's mousemove sees the trail.
  await page.mouse.move(
    betaBox.x + betaBox.width / 2,
    betaBox.y + betaBox.height * 0.75,
    { steps: 5 },
  );
  await page.mouse.up();

  // After reorder: beta row first, then alpha row.
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`${BASE}/api/docs/${id}/tables/rows`);
        if (!r.ok()) return null;
        return (await r.json()).rows;
      },
      {
        timeout: 10000,
        message: "row order never updated",
      },
    )
    .toEqual([
      ["beta", "b2", "b3"],
      ["alpha", "a2", "a3"],
    ]);
});

test("header row has no drag handle (pinned at top)", async ({ page }) => {
  const { url } = await createPaper(page);
  await gotoPaper(page, url);
  await insertTableViaToolbar(page);

  const headerRow = page.locator(".ProseMirror table tr").first();
  await headerRow.hover();
  // The plugin only renders the handle for body rows. Header row hover
  // should leave the handle hidden (display:none).
  const handle = page.locator(".pm-row-drag-handle");
  await expect(handle).toBeHidden();

  // Hovering a body row reveals it — confirms the plugin is alive,
  // not just universally hiding.
  const bodyRow = page.locator(".ProseMirror table tr").nth(1);
  await bodyRow.hover();
  await expect(handle).toBeVisible();
});

test("nameless table appears in listing but lookup 404s", async ({ page }) => {
  const { id, url } = await createPaper(page);
  await gotoPaper(page, url);

  await insertTableViaToolbar(page);
  // Type in the first cell so the table is non-empty.
  await page.locator(".ProseMirror table th").first().click();
  await page.keyboard.type("a");

  await waitForServerVersion(page, id, 1);

  const listResp = await page.request.get(`${BASE}/api/docs/${id}/tables`);
  expect(listResp.status()).toBe(200);
  expect((await listResp.json()).tables[0].name).toBeNull();

  const lookup = await page.request.get(
    `${BASE}/api/docs/${id}/tables/anything`,
  );
  expect(lookup.status()).toBe(404);
});
