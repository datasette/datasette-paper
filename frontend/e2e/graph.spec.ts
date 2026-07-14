/**
 * @feat link-graph: E2E for the interactive link graph — the index modal
 * (full graph, zoomable, no depth control) and the doc-centred ego view
 * (rail-opened, ?focus= echo for a link-less doc, depth re-slicing).
 *
 * The suite shares one server, so the graph payload contains other tests'
 * docs too — every assertion is scoped to this file's own doc ids, never
 * to global node/edge counts.
 */
import { test, expect, type Page } from "@playwright/test";
import { createPaper, gotoPaper } from "./helpers";

const BASE = "/-/paper";

/** Poll the graph API until it carries the a→b edge (indexing is async). */
async function waitForEdge(page: Page, a: number, b: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`${BASE}/api/links/graph`);
        if (!r.ok()) return false;
        const g = (await r.json()) as {
          edges: { source: number; target: number }[];
        };
        return g.edges.some((e) => e.source === a && e.target === b);
      },
      { timeout: 15000, message: `edge ${a}->${b} never indexed` },
    )
    .toBe(true);
}

/** Type a [[wikilink]] to an existing paper and commit the first match. */
async function linkTo(page: Page, targetName: string): Promise<void> {
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await page.keyboard.type(`[[${targetName}`);
  const popup = page.locator(".pm-wikilink-popup");
  await expect(popup).toBeVisible({ timeout: 10000 });
  // Click the match rather than pressing Enter, and exclude the create row:
  // its "Create "<name>" page" label also contains the target name, and it
  // renders instantly while the real result waits on the debounced fetch.
  const match = popup.locator(".pm-wikilink-item:not(.pm-wikilink-create)", {
    hasText: targetName,
  });
  await expect(match).toBeVisible({ timeout: 10000 });
  await match.click();
  await expect(page.locator(".pm-paper-link")).toBeVisible({ timeout: 10000 });
}

const dialog = (page: Page) =>
  page.locator('#app-root [role="dialog"][aria-label="Link graph"]');
const nodeAnchor = (page: Page, id: number) =>
  dialog(page).locator(`.link-graph-nodes a[href="${BASE}/doc/${id}"]`);

test.describe("link graph", () => {
  test("index modal: linked nodes render, wheel zooms, Escape closes", async ({
    page,
  }) => {
    const token = Math.random().toString(36).slice(2, 8);
    const a = await createPaper(page, { name: `Graph Src ${token}` });
    const b = await createPaper(page, { name: `Graph Dst ${token}` });
    await gotoPaper(page, a.url);
    await linkTo(page, b.name);
    await waitForEdge(page, a.id, b.id);

    await page.goto(`${BASE}/`);
    await page.locator("#app-root .graph-toggle").click();
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });
    await expect(nodeAnchor(page, a.id)).toBeVisible({ timeout: 10000 });
    await expect(nodeAnchor(page, b.id)).toBeVisible();

    // The index graph has no ego depth control.
    await expect(
      dialog(page).getByLabel("Neighbourhood depth"),
    ).toHaveCount(0);

    // Wheel over the canvas zooms the viewport <g>.
    const svg = dialog(page).locator(".link-graph-svg");
    await svg.hover();
    await page.mouse.wheel(0, -120);
    await expect
      .poll(async () =>
        dialog(page).locator("g.link-graph-viewport").getAttribute("transform"),
      )
      .not.toContain("scale(1)");

    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
  });

  test("doc-centred ego: a link-less doc still shows its centred focus node", async ({
    page,
  }) => {
    const token = Math.random().toString(36).slice(2, 8);
    const lone = await createPaper(page, { name: `Graph Lone ${token}` });
    await gotoPaper(page, lone.url);

    await page.locator('.paper-rail-btn[aria-label="View in graph"]').click();
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });

    // The ?focus= echo produces exactly one node: the ringed focus doc —
    // not the "No links yet." empty state.
    const focus = nodeAnchor(page, lone.id);
    await expect(focus).toBeVisible({ timeout: 10000 });
    await expect(dialog(page).locator(".link-graph-nodes a")).toHaveCount(1);
    await expect(focus.locator("circle.focus-ring")).toBeVisible();
    await expect(dialog(page).getByLabel("Neighbourhood depth")).toBeVisible();

    // Backdrop click dismisses and the editor is still there.
    await page.locator(".graph-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator(".ProseMirror")).toBeVisible();
  });

  test("ego depth: 1 hides the two-hop doc, 2 reveals it", async ({ page }) => {
    const token = Math.random().toString(36).slice(2, 8);
    const a = await createPaper(page, { name: `Graph Hop A ${token}` });
    const b = await createPaper(page, { name: `Graph Hop B ${token}` });
    const c = await createPaper(page, { name: `Graph Hop C ${token}` });
    await gotoPaper(page, a.url);
    await linkTo(page, b.name);
    await gotoPaper(page, b.url);
    await linkTo(page, c.name);
    await waitForEdge(page, a.id, b.id);
    await waitForEdge(page, b.id, c.id);

    await gotoPaper(page, a.url);
    await page.locator('.paper-rail-btn[aria-label="View in graph"]').click();
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });

    // Depth 1: focus + direct neighbour only; C is two hops out.
    await expect(nodeAnchor(page, a.id)).toBeVisible({ timeout: 10000 });
    await expect(nodeAnchor(page, a.id).locator("circle.focus-ring")).toBeVisible();
    await expect(nodeAnchor(page, b.id)).toBeVisible();
    await expect(nodeAnchor(page, c.id)).toHaveCount(0);

    // Depth 2 re-slices client-side and reveals C.
    await dialog(page).getByLabel("Neighbourhood depth").selectOption("2");
    await expect(nodeAnchor(page, c.id)).toBeVisible({ timeout: 10000 });
  });
});
