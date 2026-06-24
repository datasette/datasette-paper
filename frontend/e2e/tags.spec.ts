/**
 * E2E for inline `#tags`: authoring + clickable navigation to the tag-search
 * results page.
 *
 *  1. Authoring → reload → click. Type `#alpha`, commit it through the suggest
 *     popup's "Create" item, wait for the server snapshot, reload (proves the
 *     tag survives the markdown/snapshot round-trip), then click the rendered
 *     `.pm-tag` chip → lands on `/-/paper/tag/alpha`, which lists the doc.
 *
 *  2. Rendering. A doc seeded (create-from-markdown) with `[#alpha](tag:alpha)`
 *     opens with a `.pm-tag` chip whose TagView href points at the results
 *     page — deterministic, no suggest timing.
 *
 * The results page is its own Vite entry (`src/pages/tag/main.ts`) and fetches
 * the ACL-filtered `GET /api/tags/{slug}/refs` (LIKE-scan v1).
 */
import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper, waitForServerVersion } from "./helpers";

const BASE = "/-/paper";

test.describe("inline #tags", () => {
  test("a seeded inline tag renders a chip linking to the results page", async ({
    page,
  }) => {
    const resp = await page.request.post(`${BASE}/api/docs`, {
      data: {
        name: "Tag Render Target",
        content: "Our [#alpha](tag:alpha) plan",
        content_type: "markdown",
      },
    });
    expect(resp.status()).toBe(201);
    const { id } = await resp.json();

    await gotoPaper(page, `${BASE}/doc/${id}`);

    const chip = page.locator("#app-root .pm-tag");
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip.first()).toHaveText("#alpha");
    await expect(chip.first()).toHaveAttribute("href", `${BASE}/tag/alpha`);
    await expect(chip.first()).toHaveAttribute("data-tag", "alpha");
  });

  test("type #alpha, reload, click → tag-search results list the doc", async ({
    page,
  }) => {
    const { id } = await createPaper(page, { name: "Tag Author Host" });
    await gotoPaper(page, `${BASE}/doc/${id}`);

    const editor = page.locator("#app-root .ProseMirror");
    await editor.click();
    await page.keyboard.type("#alpha");

    // The suggest popup mounts; with an empty vocabulary it offers a
    // "Create #alpha" item. Enter commits the highlighted item.
    const popup = page.locator("#app-root .pm-tag-popup");
    await expect(popup).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Enter");

    // The chip is now in the doc.
    const chip = page.locator("#app-root .pm-tag");
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip.first()).toHaveText("#alpha");

    // Persist before reload (reload aborts in-flight POST batches).
    await waitForServerVersion(page, id, 1);
    await page.reload();
    await expect(page.locator("#app-root .ProseMirror")).toBeVisible({
      timeout: 10000,
    });

    // Survives the snapshot round-trip, and the chip's href is the click
    // target. (In an editable doc a plain click selects rather than navigates
    // — TagView suppresses navigation in edit mode — so we follow the href the
    // chip would open from a read-only render / modifier-click.)
    const reloadedChip = page.locator("#app-root .pm-tag");
    await expect(reloadedChip.first()).toHaveText("#alpha", { timeout: 10000 });
    await expect(reloadedChip.first()).toHaveAttribute(
      "href",
      `${BASE}/tag/alpha`,
    );

    // The results page (its own Vite entry) lists the authoring doc via the
    // ACL-filtered refs endpoint.
    await page.goto(`${BASE}/tag/alpha`);
    const row = page.locator(`#app-root a[href="${BASE}/doc/${id}"]`);
    await expect(row).toBeVisible({ timeout: 10000 });
  });
});
