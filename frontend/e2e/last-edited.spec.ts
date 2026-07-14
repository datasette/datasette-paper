/**
 * E2E for the "edited Xm ago by Y" indicator.
 *
 * Two browser contexts on one doc: Erin (signed actor) edits, Vic watches.
 * Vic's header must flip to "by erin" live off the SSE ride-along — no
 * reload — while Erin's own header says "by you" off the send confirm (the
 * broadcast skips the originator, so her signal is the POST 200). The
 * listing's Updated column then shows the rollup-backed attribution.
 *
 * Locators are scoped to #app-root — the debug bar injects its own "act
 * as" <select> outside it.
 *
 * @feat last-edited-indicator: live header attribution on a remote edit
 * (SSE), "by you" on an own edit (confirm), and the listing's "by Y" cell.
 */
import { test, expect } from "@playwright/test";
import {
  createPaper,
  gotoPaper,
  setActorCookie,
  typeInEditor,
  waitForServerVersion,
} from "./helpers";

const EDITOR = "erin";
const VIEWER = "vic";

test("remote edit updates the viewer's header live; editor sees 'by you'", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await pageA.goto("/-/paper/");
  await setActorCookie(pageA, EDITOR);
  await pageB.goto("/-/paper/");
  await setActorCookie(pageB, VIEWER);

  const doc = await createPaper(pageA, { actorId: EDITOR });
  await gotoPaper(pageA, doc.url);
  await gotoPaper(pageB, doc.url);

  // Fresh doc: no steps yet, so no attribution on either header.
  const updatedA = pageA.locator("#app-root .updated-at");
  const updatedB = pageB.locator("#app-root .updated-at");
  await expect(updatedB).toContainText("edited");
  await expect(updatedB).not.toContainText("by");

  await typeInEditor(pageA, "attributed edit");

  // Vic's header updates without a reload (SSE ride-along; the name is
  // resolved through /actors/resolve, which falls back to the raw id).
  await expect(updatedB).toContainText(`by ${EDITOR}`, { timeout: 10000 });
  await expect(updatedB).toContainText("just now");
  // Erin's own header attributes via her send confirm.
  await expect(updatedA).toContainText("by you", { timeout: 10000 });

  await waitForServerVersion(pageA, doc.id, 1);
  await ctxA.close();
  await ctxB.close();
});

test("listing's Updated column shows the last attributed editor", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/-/paper/");
  await setActorCookie(page, EDITOR);

  const doc = await createPaper(page, { actorId: EDITOR });
  await gotoPaper(page, doc.url);
  await typeInEditor(page, "row attribution");
  // The rollup row is written with the step — make sure it landed before
  // the listing reads it.
  await waitForServerVersion(page, doc.id, 1);

  await page.goto("/-/paper/");
  const row = page.locator("#app-root tr", { hasText: doc.name });
  await expect(row.locator(".last-editor")).toContainText(`by ${EDITOR}`, {
    timeout: 10000,
  });

  await ctx.close();
});
