import { defineShot } from "../defineShot.mjs";

// Same "Deploy runbook" doc as `callouts`; opens the first callout's kind
// picker so the shot shows the 5-kind + Quote/Remove dropdown. Never selects
// a row — this shot must not mutate the doc `callouts` also captures clean,
// so `order` only needs to be *a* number (no shared-doc mutation ordering
// applies here), but it's kept just after `callouts` for locality.
export default defineShot({
  name: "callout-picker",
  order: 44,
  doc: "calloutsId",
  prepare: async (page) => {
    const first = page.locator(".pm-callout").first();
    await first.waitFor({ state: "visible", timeout: 10_000 });
    await first.locator("button.pm-callout-kind").click();
    await page
      .locator(".pm-callout-kind-popup--open")
      .waitFor({ state: "visible", timeout: 10_000 });
  },
});
