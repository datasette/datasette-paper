/**
 * E2E for `@`-mentions. Two paths:
 *
 *  1. Rendering — a doc seeded (via the create-from-markdown API) with a
 *     `[@name](paper:/actor/id)` mention opens with a `.pm-mention` pill whose
 *     NodeView resolves the live display name through the ActorResolver.
 *
 *  2. Authoring — typing `@` opens the doc-scoped suggest popup. The e2e
 *     webServer grants paper-view to everyone (an *open* audience with no
 *     named per-actor grants), so `named_viewers` enumerates nobody and the
 *     popup shows "No matches" plus the open-audience hint — which still
 *     exercises the trigger regex, popup mount, and mention-search fetch in
 *     a real browser. (Picking a named candidate needs per-actor grants,
 *     covered by tests/test_mention_search.py.)
 */
import { test, expect } from "@playwright/test";
import { gotoPaper } from "./helpers";

const BASE = "/-/paper";

test.describe("@-mentions", () => {
  test("a seeded mention renders a resolved pill", async ({ page }) => {
    // Seed a doc whose markdown contains a mention. With no user-profiles
    // installed the display name falls back to the actor id, so the pill
    // resolves to "@alice".
    const resp = await page.request.post(`${BASE}/api/docs`, {
      data: {
        name: "Mention Render Target",
        content: "Ping [@alice](paper:/actor/alice) please",
        content_type: "markdown",
      },
    });
    expect(resp.status()).toBe(201);
    const { id } = await resp.json();

    await gotoPaper(page, `${BASE}/doc/${id}`);

    const pill = page.locator(".pm-mention");
    await expect(pill).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => pill.first().innerText(), {
        timeout: 10000,
        message: "mention never resolved its display name",
      })
      .toContain("@alice");
    // The id rides in data-mention for hover/copy.
    await expect(pill.first()).toHaveAttribute("data-mention", "alice");
  });

  test("typing `@` opens the suggest popup", async ({ page }) => {
    const resp = await page.request.post(`${BASE}/api/docs`, {
      data: { name: "Mention Author Host" },
    });
    expect(resp.status()).toBe(201);
    const { id } = await resp.json();
    await gotoPaper(page, `${BASE}/doc/${id}`);

    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("@al");

    // Popup mounts on activation and runs the debounced mention-search fetch.
    const popup = page.locator(".pm-mention-popup");
    await expect(popup).toBeVisible({ timeout: 10000 });
    // No named viewers in the e2e open-audience config → "No matches".
    await expect(popup.locator(".pm-mention-empty")).toBeVisible({
      timeout: 10000,
    });

    // Escape dismisses the popup; the typed trigger text remains as plain
    // text (no mention committed).
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden({ timeout: 10000 });
    await expect(editor).toContainText("@al");
  });
});
