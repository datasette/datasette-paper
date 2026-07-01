/**
 * E2E for the authors byline.
 *
 * The webServer grants paper-view/-edit globally but NOT paper-manage, and
 * creates papers anonymously — so the *manager* path needs a real owner. We
 * create the doc as a signed actor (→ seeded Manager grant + author #0), grant
 * a second actor an acl Editor role via datasette-acl's JSON API (that's what
 * makes them an author *candidate* — global-config edit isn't a grant), then:
 *
 *  1. Read-only: an anonymous viewer (canManage=false) sees the byline in the
 *     sidebar + doc header but no add/remove controls.
 *  2. Manager: the owner opens the doc (canManage=true), adds the granted
 *     collaborator through the picker, and the byline updates live.
 */
import { test, expect, type Page } from "@playwright/test";
import { createPaper, gotoPaper, setActorCookie, cookieHeader } from "./helpers";

const BASE = "/-/paper";

/** Grant `actorId` an acl Editor role on the doc, as `manager` (the owner). */
async function grantEditor(
  page: Page,
  docId: number,
  actorId: string,
  manager: string,
): Promise<void> {
  const resp = await page.request.post(
    `/-/acl/api/resource/paper-doc/_paper/${docId}/grant`,
    { data: { actor_id: actorId, role: "Editor" }, headers: { Cookie: cookieHeader(manager) } },
  );
  expect(resp.ok()).toBeTruthy();
}

/** Add `actorId` to the byline via the API, as `manager`. */
async function addAuthor(
  page: Page,
  docId: number,
  actorId: string,
  manager: string,
): Promise<void> {
  const resp = await page.request.post(`${BASE}/api/docs/${docId}/authors/add`, {
    data: { actor_id: actorId },
    headers: { Cookie: cookieHeader(manager) },
  });
  expect(resp.ok()).toBeTruthy();
}

test.describe("authors byline", () => {
  test("an anonymous viewer sees the byline read-only", async ({ page }) => {
    const { id, url } = await createPaper(page, {
      name: "Authored doc",
      actorId: "alice",
    });
    await grantEditor(page, id, "bob", "alice");
    await addAuthor(page, id, "bob", "alice");

    // Open anonymously (global paper-view) → canManage is false.
    await gotoPaper(page, url);

    const panel = page.locator("#app-root .authors-panel");
    await expect(panel).toBeVisible({ timeout: 10000 });
    await expect(panel).toContainText("alice");
    await expect(panel).toContainText("bob");
    // No management affordances for a viewer.
    await expect(panel.getByText("+ Add author")).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Remove author" }),
    ).toHaveCount(0);

    // The doc-header byline mirrors it.
    await expect(page.locator("#app-root .byline")).toContainText("Authors:");
  });

  test("a manager adds a collaborator through the picker", async ({ page }) => {
    const { id, url } = await createPaper(page, {
      name: "Manager authored",
      actorId: "alice",
    });
    await grantEditor(page, id, "bob", "alice");

    // Open as the owner → canManage is true, so the editor affordances show.
    await page.goto(`${BASE}/`);
    await setActorCookie(page, "alice");
    await gotoPaper(page, url);

    const panel = page.locator("#app-root .authors-panel");
    await expect(panel).toBeVisible({ timeout: 10000 });
    // Seeded author #0 is present; bob is not yet credited.
    await expect(panel).toContainText("alice");
    await expect(panel).not.toContainText("bob");

    // Open the picker and add bob (an eligible candidate via his Editor grant).
    await panel.getByText("+ Add author").click();
    const candidate = panel.getByRole("button", { name: /bob/ });
    await expect(candidate).toBeVisible({ timeout: 10000 });
    await candidate.click();

    // Byline now credits bob, with a remove control (manager view).
    await expect(panel).toContainText("bob", { timeout: 10000 });
    await expect(
      panel.getByRole("button", { name: "Remove author" }).first(),
    ).toBeVisible();
  });
});
