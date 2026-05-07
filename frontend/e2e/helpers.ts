import { type Page, expect } from "@playwright/test";

const BASE = `/-/paper`;

/**
 * Create a new paper via the JSON API and return both the URL and id.
 * Each call uses a unique name so tests don't collide.
 */
export async function createPaper(
  page: Page,
  name?: string,
): Promise<{ id: number; url: string; name: string }> {
  const paperName =
    name ?? `E2E-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resp = await page.request.post(`${BASE}/api/docs`, {
    data: { name: paperName },
  });
  expect(resp.status()).toBe(201);
  const data = await resp.json();
  return { id: data.id, url: `${BASE}/doc/${data.id}`, name: paperName };
}

/**
 * Navigate to a paper URL and wait for the editor to be ready.
 * Confirms by waiting for the .ProseMirror contenteditable surface.
 */
export async function gotoPaper(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });
  // ProseMirror initializes contenteditable=true once the EditorView mounts.
  await expect(page.locator(".ProseMirror")).toHaveAttribute(
    "contenteditable",
    "true",
    { timeout: 5000 },
  );
}

/**
 * Type text into the editor. Clicks to focus first.
 */
export async function typeInEditor(page: Page, text: string) {
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await page.keyboard.type(text);
}

/**
 * Wait for the editor's text content to contain the given substring.
 * Uses polling because edits propagate via SSE on the receiving side.
 */
export async function expectEditorContains(page: Page, substring: string) {
  await expect
    .poll(
      async () =>
        (await page.locator(".ProseMirror").innerText()).includes(substring),
      { timeout: 10000, message: `editor never contained "${substring}"` },
    )
    .toBe(true);
}

/**
 * Poll the bootstrap API until the doc's server-side version is at least
 * ``minVersion``. Use this before reloading the page so any in-flight
 * POST /events batches have time to land — `page.reload()` aborts
 * pending requests, and ProseMirror's collab plugin batches keystrokes
 * into multiple POSTs that may not all complete in event-loop order.
 */
export async function waitForServerVersion(
  page: Page,
  docId: number,
  minVersion: number,
) {
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`${BASE}/api/docs/${docId}`);
        if (!r.ok()) return -1;
        return (await r.json()).version as number;
      },
      {
        timeout: 10000,
        message: `server version never reached ${minVersion}`,
      },
    )
    .toBeGreaterThanOrEqual(minVersion);
}
