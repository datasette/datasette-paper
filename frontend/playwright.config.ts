import { defineConfig, devices } from "@playwright/test";

const PORT = 8485;
const INTERNAL_DB = "/tmp/datasette-paper-e2e-internal.db";
// A small user database attached to the server so inline_embed / block_embed
// have a real resource to resolve + render via the native Datasette JSON API
// (the `vendors` table).
const DATA_DB = "/tmp/datasette-paper-e2e-data.db";
const SETUP_DATA_DB = `uv run --prerelease=allow python3 -c '
import sqlite3
db = sqlite3.connect("${DATA_DB}")
db.execute("create table vendors (id integer primary key, name text)")
db.executemany("insert into vendors (id, name) values (?, ?)", [(i, "Vendor %d" % i) for i in range(1, 31)])
db.commit(); db.close()
'`;
// Fixed signing secret so the helpers in `e2e/helpers.ts` can mint
// signed actor cookies for owner-flow tests (lock-as-owner, etc.).
// Must NOT be a real production value — this is hard-coded in the
// harness on purpose.
const E2E_SECRET = "e2e-test-secret-not-for-prod";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Papers live in Datasette's internal DB. We wipe it before each
    // playwright invocation (tests within the run share state).
    // Single-user e2e setup: every browser session is "anonymous" but should
    // still be able to create + view + edit papers. Listing is ungated, so we
    // only grant the global datasette-paper-create action plus the resource
    // actions paper-view + paper-edit globally (using the real acl action
    // names) — but NOT paper-manage, so the share dialog opens read-only
    // (canManage false). Per-paper ownership / manage gating is covered by
    // backend tests, not the playwright suite.
    // `--plugins-dir ../tests/sample-plugin` loads the sample embed providers
    // (playlist/widget) so sample-embeds.spec.ts can exercise the JS render +
    // permission path. Harmless to the other specs (they don't use it).
    // `profile_access true` opens datasette-user-profiles' own profile page
    // (its routes gate on that action) so profile-papers.spec.ts can load a
    // profile and assert paper's registered "Papers" section — additive to
    // another plugin's surface, not a change to paper's own view+edit grants.
    command: `rm -f ${INTERNAL_DB} ${DATA_DB} && ${SETUP_DATA_DB} && uv run --prerelease=allow datasette --internal ${INTERNAL_DB} ${DATA_DB} --plugins-dir ../tests/sample-plugin --secret '${E2E_SECRET}' -s permissions.datasette-paper-create true -s permissions.paper-view true -s permissions.paper-edit true -s permissions.profile_access true -p ${PORT}`,
    env: { DATASETTE_PAPER_E2E_SECRET: E2E_SECRET },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
