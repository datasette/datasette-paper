import { test, expect } from "@playwright/test";
import { createPaper, gotoPaper } from "./helpers";

/**
 * Share dialog smoke tests. The e2e webServer grants all four paper
 * permissions globally and runs without an actor cookie, so docs are
 * created with created_by=NULL → canManage is false → the dialog
 * renders in read-only mode. Test that the read-only path renders +
 * closes cleanly. The full owner-flow (visibility radio + add/remove)
 * is covered by the backend share tests + frontend smoke test.
 */

test("Share button opens dialog and Close dismisses it", async ({ page }) => {
  const { url } = await createPaper(page);
  await gotoPaper(page, url);

  await expect(page.getByRole("dialog", { name: "Share dialog" })).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "Share", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Share dialog" });
  await expect(dialog).toBeVisible();

  // Read-only mode: only the Close button is rendered (no Cancel/Save).
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveCount(0);

  // The "anonymous" owner row renders since the paper was created without
  // a signed actor cookie.
  await expect(dialog.getByText("anonymous")).toBeVisible();

  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Share dialog" })).toHaveCount(
    0,
  );
});

test("Share dialog read-only mode hides the add-person form", async ({
  page,
}) => {
  const { url } = await createPaper(page);
  await gotoPaper(page, url);

  await page.getByRole("button", { name: "Share", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Share dialog" });
  await expect(dialog).toBeVisible();

  // No "Add" button or actor-id input when canManage is false.
  await expect(
    dialog.getByRole("button", { name: "Add", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByLabel("Add person — actor id"),
  ).toHaveCount(0);
});
