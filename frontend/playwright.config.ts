import { defineConfig, devices } from "@playwright/test";

const PORT = 8485;
const INTERNAL_DB = "/tmp/datasette-paper-e2e-internal.db";
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
    // still be able to create + view + edit papers. Grant the two global
    // actions (datasette-paper-list / -create) plus the resource actions
    // paper-view + paper-edit globally — but NOT paper-manage, so the share
    // dialog opens read-only (canManage false). Per-paper ownership / manage
    // gating is covered by backend tests, not the playwright suite.
    command: `rm -f ${INTERNAL_DB} && uv run --prerelease=allow datasette --internal ${INTERNAL_DB} --secret '${E2E_SECRET}' -s permissions.datasette-paper-list true -s permissions.datasette-paper-create true -s permissions.paper-view true -s permissions.paper-edit true -p ${PORT}`,
    env: { DATASETTE_PAPER_E2E_SECRET: E2E_SECRET },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
