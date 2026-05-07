import { defineConfig, devices } from "@playwright/test";

const PORT = 8485;
const INTERNAL_DB = "/tmp/datasette-paper-e2e-internal.db";

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
    // Grant all four paper actions globally — single-user e2e setup where
    // every browser session is "anonymous" but should still be able to
    // create + view + edit papers. Per-paper ownership / share gating is
    // covered by backend tests, not the playwright suite.
    command: `rm -f ${INTERNAL_DB} && uv run --prerelease=allow datasette --internal ${INTERNAL_DB} -s permissions.datasette-paper-list true -s permissions.datasette-paper-create true -s permissions.datasette-paper-view true -s permissions.datasette-paper-edit true -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
