import { type Page, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

const BASE = `/-/paper`;

// Must match the value in playwright.config.ts. Hard-coding it here
// (rather than reading from an env var) keeps the helpers usable
// without prepping the shell — and it's a fixed test value, never
// secret.
const E2E_SECRET = "e2e-test-secret-not-for-prod";

// itsdangerous (which Datasette's ``sign`` uses under the hood)
// doesn't have a maintained Node port. Easiest portable path: shell
// out to a tiny python one-liner that imports itsdangerous and
// returns the signed payload. Cached per actor id so we don't pay
// the subprocess cost more than once per actor per run.
const _actorCookieCache = new Map<string, string>();

export function signActorCookie(actorId: string): { ds_actor: string } {
  let signed = _actorCookieCache.get(actorId);
  if (!signed) {
    const out = execFileSync(
      "uv",
      [
        "run",
        "--prerelease=allow",
        "python",
        "-c",
        // Mirrors Datasette.sign() — URLSafeSerializer with the
        // configured secret + a per-purpose salt of "actor".
        "import sys, json; from itsdangerous import URLSafeSerializer; " +
          "print(URLSafeSerializer(sys.argv[1]).dumps(" +
          'json.loads(sys.argv[2]), salt="actor"))',
        E2E_SECRET,
        JSON.stringify({ a: { id: actorId } }),
      ],
      { encoding: "utf-8", cwd: process.cwd() },
    );
    signed = out.trim();
    _actorCookieCache.set(actorId, signed);
  }
  return { ds_actor: signed };
}

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
    /** Sign the request as this actor so the new doc gets created_by
     * set to ``actorId`` (and isOwner=true on subsequent reads).
     * Without this the doc is created anonymously with NULL owner. */
    actorId?: string;
  } = {},
): Promise<{ id: number; url: string; name: string }> {
  const paperName =
    opts.name ?? `E2E-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const data: Record<string, unknown> = { name: paperName };
  if (opts.kind) data.kind = opts.kind;
  if (opts.templateId !== undefined) data.template_id = opts.templateId;
  const requestOpts: Parameters<typeof page.request.post>[1] = { data };
  if (opts.actorId) {
    requestOpts.headers = { Cookie: cookieHeader(opts.actorId) };
  }
  const resp = await page.request.post(`${BASE}/api/docs`, requestOpts);
  expect(resp.status()).toBe(201);
  const body = await resp.json();
  return { id: body.id, url: `${BASE}/doc/${body.id}`, name: paperName };
}

/** Build a ``Cookie:`` header value with a signed actor cookie for
 * direct page.request.* calls. For full-page navigation (page.goto),
 * use ``setActorCookie`` instead so the browser context retains it. */
export function cookieHeader(actorId: string): string {
  return `ds_actor=${signActorCookie(actorId).ds_actor}`;
}

/** Install a signed actor cookie on the browser context so subsequent
 * page.goto() calls present as ``actorId``. The cookie is path-/
 * which matches Datasette's own behavior. Call this in beforeEach
 * before navigating. */
export async function setActorCookie(
  page: Page,
  actorId: string,
): Promise<void> {
  const url = new URL(page.url() || "http://localhost:8485/-/paper/");
  await page.context().addCookies([
    {
      name: "ds_actor",
      value: signActorCookie(actorId).ds_actor,
      domain: url.hostname,
      path: "/",
    },
  ]);
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
