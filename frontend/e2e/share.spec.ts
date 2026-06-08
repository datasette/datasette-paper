import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper } from "./helpers";

/**
 * Share dialog smoke tests. Sharing UI is owned by datasette-acl-share's
 * <datasette-acl-share-dialog> custom element: it renders its own share-icon
 * trigger (paper restyles it as the blue "Share" pill) and a native <dialog>
 * modal. Paper no longer wraps it in a bespoke modal — it just embeds the
 * element and listens for `share-changed` to sweep SSE subscribers.
 *
 * The e2e webServer runs without an actor cookie, so docs are created with
 * created_by=NULL and no owner grant is seeded → the anonymous actor cannot
 * manage, so the dialog opens read-only. The detailed grant/role behaviour is
 * covered by datasette-acl-share's own component tests plus paper's backend
 * share tests; here we only verify paper embeds + wires the element.
 */

test("Share trigger opens the acl share dialog and Close dismisses it", async ({
  page,
}) => {
  const { url } = await createPaper(page);
  await gotoPaper(page, url);

  const dialog = page.locator("dialog.datasette-acl-share-dialog");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Share" }).click();
  await expect(dialog).toBeVisible();

  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeVisible();
  await close.click();
  await expect(dialog).toBeHidden();
});

test("Share dialog opens read-only for a non-manager", async ({ page }) => {
  const { url } = await createPaper(page);
  await gotoPaper(page, url);

  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.locator("dialog.datasette-acl-share-dialog");
  await expect(dialog).toBeVisible();

  // canManage is false → the add-box (people/group search) is not rendered.
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
});
