import { defineShot } from "../defineShot.mjs";

// The paper index: a list of papers with creators, tags, and the filter bar.
export default defineShot({
  name: "index",
  order: 1,
  prepare: async (page) => {
    await page.locator(".paper-index table tbody tr").first().waitFor({ timeout: 15_000 });
  },
});
