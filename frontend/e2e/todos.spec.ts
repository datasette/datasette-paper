/**
 * E2E for the task-assign TODO surfaces. A @mention inside a task item assigns
 * it; a date atom is its due date; both are pure interpretation of doc content
 * (no assignment UI). A markdown-seeded doc populates the m009 index on create
 * (the create-path reindex), and the /todos endpoint feeds both the dedicated
 * `/-/paper/todos` page and the profile `<profile-todos>` section.
 *
 * The date buckets are computed in the viewer's timezone against the real
 * clock, so these use a far-future due date for a deterministic "Later" bucket
 * rather than coupling to the machine time.
 *
 * ACL filtering (a doc the viewer can't see stays absent) is covered at the API
 * layer in tests/test_profile_todos.py — the e2e config grants view+edit
 * globally, so it can't exercise the deny path here.
 *
 * @feat task-assign: full-stack proof that a @mentioned, dated task surfaces on
 * the /-/paper/todos page (bucketed, due chip, doc badge, row → doc) and in the
 * profile <profile-todos> section, with inheritance and check-off honored.
 */
import { test, expect } from "@playwright/test";

const BASE = "/-/paper";
const ACTOR = "todo-user";

/** Seed a doc from markdown; returns its id. The create-path reindex fills the
 *  assignment index, so /todos sees it with no edit. */
async function seedDoc(
  page: import("@playwright/test").Page,
  name: string,
  content: string,
): Promise<number> {
  const resp = await page.request.post(`${BASE}/api/docs`, {
    data: { name, content, content_type: "markdown" },
  });
  expect(resp.status()).toBe(201);
  return (await resp.json()).id;
}

test.describe("task-assign TODO surfaces", () => {
  test("an assigned, dated task shows on the /todos page and links to its doc", async ({
    page,
  }) => {
    const name = `Launch Plan ${Date.now()}`;
    const id = await seedDoc(
      page,
      name,
      "## Backend\n\n" +
        `- [ ] [@${ACTOR}](paper:/actor/${ACTOR}) fix the door ` +
        "[due](paper:/date/2099-01-01)\n",
    );

    await page.goto(`${BASE}/todos?actor=${ACTOR}`);

    // The row lands under the "Later" bucket (far-future due date).
    const bucket = page
      .locator("#app-root .todos-bucket")
      .filter({ hasText: "Later" });
    const row = bucket.locator(".todos-row", { hasText: "fix the door" });
    await expect(row).toBeVisible({ timeout: 10000 });

    // Due chip + doc badge present; text drops the mention/date atoms.
    await expect(row.locator(".todos-due")).toBeVisible();
    await expect(row.locator(".todos-doc")).toHaveText(name);
    // Section breadcrumb from the enclosing heading.
    await expect(row.locator(".todos-crumb")).toHaveText("Backend");

    // Clicking the row navigates to the doc.
    await row.locator(".todos-text").click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/doc/${id}`));
  });

  test("checking the box in the editor moves the task from Open to Done", async ({
    page,
  }) => {
    const id = await seedDoc(
      page,
      `Chores ${Date.now()}`,
      `- [ ] [@${ACTOR}](paper:/actor/${ACTOR}) close the window\n`,
    );

    // Open the doc and check the task's box.
    await page.goto(`${BASE}/doc/${id}`);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10000 });
    const checkbox = page.locator('.ProseMirror input[type="checkbox"]').first();
    await expect(checkbox).toBeVisible({ timeout: 10000 });
    await checkbox.click();

    // Wait for the toggle (a setNodeMarkup step + its write-tail reindex) to
    // land server-side before the list re-reads the index.
    await expect
      .poll(
        async () => {
          const r = await page.request.get(
            `${BASE}/api/profile/${ACTOR}/todos?status=open`,
          );
          const rows = (await r.json()).todos as { doc_id: number }[];
          return rows.some((t) => t.doc_id === id);
        },
        { timeout: 10000, message: "task never left the open set" },
      )
      .toBe(false);

    // Open list: the checked task is gone.
    await page.goto(`${BASE}/todos?actor=${ACTOR}`);
    await expect(
      page.locator("#app-root .todos-row", { hasText: "close the window" }),
    ).toHaveCount(0);

    // Switch to Done: it reappears, struck through.
    await page.locator("#app-root .todos-status-btn", { hasText: "Done" }).click();
    const doneRow = page.locator("#app-root .todos-row", {
      hasText: "close the window",
    });
    await expect(doneRow).toBeVisible({ timeout: 10000 });
    await expect(doneRow).toHaveClass(/is-done/);
  });

  test("a mention-less subtask inherits its parent's assignee", async ({
    page,
  }) => {
    await seedDoc(
      page,
      `Nested ${Date.now()}`,
      `- [ ] [@${ACTOR}](paper:/actor/${ACTOR}) parent task\n` +
        "  - [ ] silent subtask\n",
    );

    await page.goto(`${BASE}/todos?actor=${ACTOR}`);
    // Both the parent and the inherited subtask appear for the assignee.
    await expect(
      page.locator("#app-root .todos-row", { hasText: "parent task" }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator("#app-root .todos-row", { hasText: "silent subtask" }),
    ).toBeVisible({ timeout: 10000 });
  });

  test("the profile page shows the TODOs section with a footer link", async ({
    page,
  }) => {
    const name = `Profile Task Doc ${Date.now()}`;
    await seedDoc(
      page,
      name,
      `- [ ] [@${ACTOR}](paper:/actor/${ACTOR}) review the PR\n`,
    );

    await page.goto(`/-/profile/${ACTOR}`);

    // The TODOs section heading is always present (host-page contract).
    const section = page.locator(".profile-section", { hasText: "TODOs" });
    await expect(section.locator("h2")).toContainText("TODOs");

    const todos = page.locator("profile-todos");
    const row = todos.locator(".paper-todos-item", { hasText: "review the PR" });
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row.locator(".paper-todos-doc")).toHaveText(name);

    // Footer link out to the full page for this actor.
    const more = todos.locator(".paper-todos-more");
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute("href", `/-/paper/todos?actor=${ACTOR}`);
  });
});
