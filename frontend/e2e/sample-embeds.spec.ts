/**
 * E2E for third-party custom embeds, driven by the sample plugin
 * (tests/sample-plugin, loaded via the webServer's --plugins-dir).
 *
 * Proves the full lazy-load + JS render path that backend tests can't reach:
 *   - a doc using a provider embed lazy-injects that provider's bundle, which
 *     registers and renders — inline pill (resolve) + block card (mount),
 *   - the render is permission-gated by the provider's OWN routes against the
 *     viewer's cookie: a public playlist/widget renders rich content; an
 *     owner-only playlist renders a "no access" message for a non-member.
 */
import { test, expect, type Page } from "@playwright/test";
import { cookieHeader, setActorCookie, gotoPaper } from "./helpers";

const FENCE = "```";

/** Create a paper with markdown `content`, owned by `actorId`. */
async function createDocWithContent(
  page: Page,
  actorId: string,
  name: string,
  content: string,
): Promise<string> {
  const resp = await page.request.post("/-/paper/api/docs", {
    data: { name, content },
    headers: { Cookie: cookieHeader(actorId) },
  });
  expect(resp.status()).toBe(201);
  return `/-/paper/doc/${(await resp.json()).id}`;
}

/** Open `url` as `actorId`. The embeds fetch their data with this cookie, so
 * it must be set before navigating — and setActorCookie needs an established
 * origin first, hence the initial index visit. */
async function openAs(page: Page, actorId: string, url: string): Promise<void> {
  await page.goto("/-/paper/");
  await setActorCookie(page, actorId);
  await gotoPaper(page, url);
}

test.describe("third-party custom embeds (sample plugin)", () => {
  test("public playlist + widget lazy-load and render (inline + block)", async ({
    page,
  }) => {
    const content = [
      "# Embeds demo",
      "",
      "Inline: [Front Page Hits](datasette:/-/sample-embeds/playlists/front-page-hits)",
      "",
      `${FENCE}datasette-embed`,
      "/-/sample-embeds/playlists/front-page-hits",
      FENCE,
      "",
      `${FENCE}datasette-embed`,
      "/-/sample-embeds/widgets/newsstand",
      FENCE,
      "",
    ].join("\n");
    const url = await createDocWithContent(page, "tester", "Public embeds", content);
    await openAs(page, "tester", url);

    // Inline pill resolves to the playlist title (provider `resolve`).
    await expect(
      page.locator(".pm-inline-embed", { hasText: "Front Page Hits" }),
    ).toBeVisible({ timeout: 15000 });

    // Block playlist card renders the rich track list (provider `mount`).
    const playlist = page.locator(".pm-block-embed .sample-playlist");
    await expect(playlist).toBeVisible({ timeout: 15000 });
    await expect(playlist).toContainText("Stop the Presses");

    // Block widget card renders the gauge — title in the card header (paper's
    // chrome), the metric value in the provider-rendered body.
    const widget = page.locator(".pm-block-embed", {
      has: page.locator(".sample-widget-gauge"),
    });
    await expect(widget).toContainText("Newsstand Sales", { timeout: 15000 });
    await expect(widget.locator(".sample-widget-gauge")).toContainText("42%");
  });

  test("an owner-only playlist renders a permission message for a non-member", async ({
    page,
  }) => {
    const content = [
      "# Restricted",
      "",
      `${FENCE}datasette-embed`,
      "/-/sample-embeds/playlists/summer-mix",
      FENCE,
      "",
    ].join("\n");
    // `tester` owns the doc (can open it) but is not in summer-mix's newsroom,
    // so the provider denies the data and the card shows the no-access message.
    const url = await createDocWithContent(page, "tester", "Restricted embed", content);
    await openAs(page, "tester", url);

    await expect(page.locator(".pm-block-embed")).toContainText(
      "don't have access",
      { timeout: 15000 },
    );
    // Leak discipline: the playlist title never appears.
    await expect(page.locator(".pm-block-embed")).not.toContainText(
      "Summer Road-Trip Mix",
    );
  });
});
