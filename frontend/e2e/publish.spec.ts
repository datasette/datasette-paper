import { test, expect } from "@playwright/test";
import { cookieHeader, createPaper, gotoPaper, setActorCookie } from "./helpers";

// Paper API/page root (relative — resolved against playwright's baseURL).
const BASE = `/-/paper`;

// A doc with prose + a live SQL block against the `data` db (vendors table).
const CONTENT = [
  "# Published report",
  "",
  "Hello from a **published** page.",
  "",
  "```sql db=datasette-paper-e2e-data",
  "select id, name from vendors order by id limit 3",
  "```",
  "",
].join("\n");

async function createOwnedDoc(request: import("@playwright/test").APIRequestContext) {
  const resp = await request.post(`${BASE}/api/docs`, {
    data: { name: "Publish E2E", content: CONTENT },
    headers: { Cookie: cookieHeader("alice") },
  });
  expect(resp.status()).toBe(201);
  return (await resp.json()).id as number;
}

test("published page renders statically and hydrates live blocks", async ({
  page,
  request,
}) => {
  const id = await createOwnedDoc(request);

  // Publish to everyone (owner alice is auto-granted; everyone makes it public).
  const pub = await request.post(`${BASE}/api/docs/${id}/publish`, {
    data: { audience: [{ principal: "everyone" }] },
    headers: { Cookie: cookieHeader("alice") },
  });
  expect(pub.status()).toBe(200);

  // Flag if the page ever opens an SSE stream (it must not).
  await page.addInitScript(() => {
    (window as unknown as { __sseOpened: boolean }).__sseOpened = false;
    const Orig = window.EventSource;
    // @ts-expect-error override for the assertion
    window.EventSource = function (...args: unknown[]) {
      (window as unknown as { __sseOpened: boolean }).__sseOpened = true;
      // @ts-expect-error spread into constructor
      return new Orig(...args);
    };
  });

  await page.goto(`${BASE}/doc/${id}/publish`);

  // Prose is server-rendered → present immediately, no editor.
  await expect(page.locator(".paper-published h1")).toHaveText("Published report");
  await expect(page.locator(".paper-published strong")).toHaveText("published");
  await expect(page.locator(".ProseMirror")).toHaveCount(0);

  // The live SQL block hydrates client-side into a results table.
  await expect(
    page.locator(".paper-published .pm-sql-block .pm-data-table"),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator(".paper-published .pm-sql-block .pm-data-table tbody tr"),
  ).toHaveCount(3);

  // No SSE was ever opened.
  expect(await page.evaluate(() => (window as unknown as { __sseOpened: boolean }).__sseOpened)).toBe(
    false,
  );
});

test("owner publishes from the editor dialog; non-owner has no Publish button", async ({
  page,
}) => {
  await page.goto("/-/paper/");
  await setActorCookie(page, "alice");
  const doc = await createPaper(page, { name: "Dialog publish", actorId: "alice" });
  await gotoPaper(page, doc.url);

  // The owner sees a Publish button; open the dialog, go public, publish.
  await expect(page.locator(".publish-btn")).toBeVisible();
  await page.locator(".publish-btn").click();
  await expect(page.locator(".publish-dialog")).toBeVisible();
  await page.locator('.publish-dialog input[type="radio"][value="public"]').check();
  await page.locator(".publish-dialog").getByRole("button", { name: "Publish" }).click();

  // The header badge appears and the published page is now world-readable.
  await expect(page.locator(".published-badge")).toBeVisible({ timeout: 10_000 });
  const anon = await page.request.get(`/-/paper/doc/${doc.id}/publish`, {
    headers: { Cookie: "ds_actor=nonsense" },
  });
  expect(anon.status()).toBe(200);

  // A non-owner editing surface has no Publish button.
  const ctx = await page.context().browser()!.newContext();
  const other = await ctx.newPage();
  await other.goto(doc.url);
  await expect(other.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });
  await expect(other.locator(".publish-btn")).toHaveCount(0);
  await ctx.close();
});

test("unpublished / out-of-audience publish page is 404", async ({ request }) => {
  const id = await createOwnedDoc(request);

  // Never published → 404 even for the owner.
  const pre = await request.get(`${BASE}/doc/${id}/publish`, {
    headers: { Cookie: cookieHeader("alice") },
  });
  expect(pre.status()).toBe(404);

  // Publish privately (owner only) → a stranger gets 404, not 403.
  await request.post(`${BASE}/api/docs/${id}/publish`, {
    data: {},
    headers: { Cookie: cookieHeader("alice") },
  });
  const stranger = await request.get(`${BASE}/doc/${id}/publish`, {
    headers: { Cookie: cookieHeader("mallory") },
  });
  expect(stranger.status()).toBe(404);
});
