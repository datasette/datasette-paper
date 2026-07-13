/**
 * E2E for the profile "Papers" section — the datasette-user-profiles
 * integration. Paper registers a `<profile-papers>` section via the
 * `datasette_user_profile_sections` hook; user-profiles renders its heading and
 * injects paper's bundle, which fetches `/-/paper/api/profile/<actor>/docs` and
 * lists the actor's created / recently-edited docs. This spec drives the whole
 * chain in a real browser: create + edit a doc as actor P, then visit P's
 * profile page and assert the section lists the doc with the right badge and a
 * link to `/-/paper/doc/<id>`.
 *
 * The profile page belongs to another plugin, so locators are scoped to the
 * `.profile-section` / `<profile-papers>` element — never `#app-root` (which
 * only exists on paper's own pages) and never the debug bar's "act as" select.
 *
 * @feat profile-papers: full-stack proof that a doc created + edited by actor P
 * surfaces under P's user-profiles profile page in the <profile-papers> element,
 * badged Created/Edited and linking to /-/paper/doc/<id>.
 */
import { test, expect } from "@playwright/test";
import {
  createPaper,
  gotoPaper,
  setActorCookie,
  typeInEditor,
  waitForServerVersion,
} from "./helpers";

const ACTOR = "profile-pat";

test.describe("profile papers section", () => {
  test("a doc created + edited by P shows on P's profile", async ({ page }) => {
    // Establish a URL so setActorCookie can derive the host, then present as P
    // for every subsequent request in this context (the edit's step must
    // attribute to P so an activity row is recorded).
    await page.goto("/-/paper/");
    await setActorCookie(page, ACTOR);

    // Create as P (created_by = P) and append a step attributed to P by typing.
    const name = `Profile Doc ${Date.now()}`;
    const doc = await createPaper(page, { name, actorId: ACTOR });
    await gotoPaper(page, doc.url);
    await typeInEditor(page, "Edited by P");
    // Let the step batch land before navigating away — reload/navigation aborts
    // in-flight POST /events, and the profile assertion depends on that step.
    await waitForServerVersion(page, doc.id, 1);

    // Visit P's user-profiles profile page (a different plugin's page).
    await page.goto(`/-/profile/${ACTOR}`);

    // The Papers section heading is always present (host-page contract).
    const section = page.locator(".profile-section", { hasText: "Papers" });
    await expect(section.locator("h2")).toContainText("Papers");

    // The created + edited doc appears inside <profile-papers>, badged and
    // linking to /-/paper/doc/<id>.
    const papers = page.locator("profile-papers");
    const row = papers.locator(".paper-profile-item", { hasText: name });
    await expect(row).toBeVisible({ timeout: 10000 });

    const link = row.locator(".paper-profile-link");
    await expect(link).toHaveText(name);
    // doc.url is `/-/paper/doc/<id>` — the exact href the endpoint emits.
    await expect(link).toHaveAttribute("href", doc.url);

    // Created by P and edited by P → the "Created · edited" badge.
    await expect(row.locator(".paper-profile-badge")).toContainText("Created");

    // Negative case (a viewer without paper-view on a doc must not see it on
    // P's profile) is NOT expressible here: the e2e config statically grants
    // paper-view + paper-edit globally. pytest owns it —
    // tests/test_profile_docs.py::test_route_permission_matrix (doc C).
  });
});
