import { defineShot } from "../defineShot.mjs";

// Full-page capture of the "Deploy runbook" fixture: one of each of the five
// callout kinds, each accent-colored via its own left border + icon. No
// interaction needed — just wait for the last callout to mount so the whole
// page (including the multi-block WARNING body's list) has settled.
export default defineShot({
  name: "callouts",
  order: 43,
  doc: "calloutsId",
  prepare: async (page) => {
    await page
      .locator(".pm-callout--caution")
      .waitFor({ state: "visible", timeout: 10_000 });
  },
});
