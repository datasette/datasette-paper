/**
 * E2E for doc-to-doc backlinks: creating a link from Doc A to Doc B should
 * surface A under Doc B's "Linked from" panel. The edge is rebuilt
 * server-side from A's `paper_link` step, so this also guards the fragile
 * part of that pipeline — the step must actually reach the server even when
 * the user navigates straight into the freshly created target.
 */
import { test, expect, type Page } from "@playwright/test";
import { createPaper, gotoPaper } from "./helpers";

const BASE = "/-/paper";

async function backlinkIds(page: Page, docId: number): Promise<number[]> {
  const r = await page.request.get(`${BASE}/api/docs/${docId}/backlinks`);
  if (!r.ok()) return [];
  return ((await r.json()).backlinks as Array<{ id: number }>).map((b) => b.id);
}

test.describe("backlinks", () => {
  test("[[-create: target lists the source under 'Linked from'", async ({
    page,
  }) => {
    const host = await createPaper(page, { name: "Backlink Source A" });
    await gotoPaper(page, host.url);

    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("[[Backlink Target B ZZZ");

    const popup = page.locator(".pm-wikilink-popup");
    await expect(popup).toBeVisible({ timeout: 10000 });
    await popup.locator(".pm-wikilink-create").click();

    const dialog = page.locator(".create-page-dialog");
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await dialog.locator(".create-page-create-btn").click();

    const link = page.locator(".pm-paper-link");
    await expect(link).toBeVisible({ timeout: 10000 });
    const href = await link.first().getAttribute("href");
    const bId = Number(href!.split("/").pop());
    expect(bId).toBeGreaterThan(0);

    // The edge is indexed server-side, then surfaced in B's Links panel.
    await gotoPaper(page, `${BASE}/doc/${bId}`);
    await page.locator('.paper-rail-btn[aria-label="Links"]').click();
    const linkedFrom = page
      .locator(".links-panel-section")
      .filter({ hasText: "Linked from" });
    await expect(linkedFrom.locator(".pm-paper-link")).toContainText(
      "Backlink Source A",
      { timeout: 10000 },
    );
  });

  test("the link step survives navigating away mid-flight", async ({ page }) => {
    // Simulate a slow backend (like a dev box with many plugins): hold the
    // POST /events that carries A's paper_link step. Without the pagehide
    // keepalive flush, navigating into B aborts that POST and the A→B edge is
    // lost forever — B's "Linked from" stays empty.
    await page.route("**/events", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((r) => setTimeout(r, 1500));
      }
      await route.continue();
    });

    const host = await createPaper(page, { name: "Slow Source A" });
    await gotoPaper(page, host.url);

    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("[[Slow Target B VVV");

    const popup = page.locator(".pm-wikilink-popup");
    await expect(popup).toBeVisible({ timeout: 10000 });
    await popup.locator(".pm-wikilink-create").click();
    const dialog = page.locator(".create-page-dialog");
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await dialog.locator(".create-page-create-btn").click();

    const link = page.locator(".pm-paper-link");
    await expect(link).toBeVisible({ timeout: 10000 });
    const href = await link.first().getAttribute("href");
    const bId = Number(href!.split("/").pop());

    // Navigate to B while A's step POST is still mid-flight (1.5s hold). The
    // pagehide handler must flush it with keepalive so the edge still lands.
    await page.goto(`${BASE}/doc/${bId}`);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });

    await expect
      .poll(async () => backlinkIds(page, bId), {
        timeout: 8000,
        message: "B never showed A as a backlink (link step lost on nav)",
      })
      .toContain(host.id);
  });
});
