/**
 * ShareDialog smoke test — verifies the module imports cleanly.
 *
 * The dialog's behavior is exercised end-to-end by the playwright share
 * spec; mounting Svelte components in the unit test environment requires
 * a browser-condition resolve pass that we don't run here, and the
 * shared openapi-fetch client doesn't have an absolute baseURL so it
 * can't drive real HTTP requests in jsdom.
 */
import { describe, it, expect } from "vitest";

describe("ShareDialog", () => {
  it("module loads without errors", async () => {
    const mod = await import("../ShareDialog.svelte");
    expect(mod.default).toBeDefined();
  });
});
