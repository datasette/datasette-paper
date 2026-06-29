import { defineShot } from "../defineShot.mjs";

// `@`-mentions resolved to live display names. Wait for the mention pills to
// resolve (the NodeView fetches through the ActorResolver after mount).
export default defineShot({
  name: "mentions",
  order: 4,
  doc: "mentionId",
  prepare: async (page) => {
    await page.locator(".pm-mention").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".pm-mention")].filter((el) =>
          /\bAda\b|\bBabbage\b|\bShaw\b/.test(el.textContent || ""),
        ).length >= 3,
      { timeout: 10_000 },
    );
  },
});
