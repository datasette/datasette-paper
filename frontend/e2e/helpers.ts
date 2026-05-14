import { type Page, expect } from "@playwright/test";

const BASE = `/-/paper`;

/**
 * Create a new paper via the JSON API and return both the URL and id.
 * Each call uses a unique name so tests don't collide.
 *
 * Pass ``kind: "template"`` to create a template instead of a regular
 * doc. Pass ``templateId`` to seed the new doc from a template — the
 * server clones the template's materialized content into the new
 * doc's version-0 snapshot.
 */
export async function createPaper(
  page: Page,
  opts: {
    name?: string;
    kind?: "doc" | "template";
    templateId?: number;
  } = {},
): Promise<{ id: number; url: string; name: string }> {
  const paperName =
    opts.name ?? `E2E-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const data: Record<string, unknown> = { name: paperName };
  if (opts.kind) data.kind = opts.kind;
  if (opts.templateId !== undefined) data.template_id = opts.templateId;
  const resp = await page.request.post(`${BASE}/api/docs`, { data });
  expect(resp.status()).toBe(201);
  const body = await resp.json();
  return { id: body.id, url: `${BASE}/doc/${body.id}`, name: paperName };
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
