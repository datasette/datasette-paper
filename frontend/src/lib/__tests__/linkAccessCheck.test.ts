/**
 * Tests for AccessChecker — the per-connection helper that fetches the doc's
 * cross-access report and caches gap info keyed by target doc id. `fetch` is
 * stubbed; a successful response populates `get()`, while a 403 (non-editor)
 * leaves the cache empty without throwing.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { AccessChecker } from "../linkAccessCheck";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AccessChecker", () => {
  it("load() populates get() from the links map (string keys → numbers)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          links: {
            "42": { gap: true, missing: ["bob"], open_audience: false },
          },
        }),
      })),
    );
    const checker = new AccessChecker("1");
    await checker.load();
    expect(checker.get(42)).toEqual({
      gap: true,
      missing: ["bob"],
      open_audience: false,
    });
    expect(checker.get(99)).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("notifies subscribers after a successful load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ links: {} }),
      })),
    );
    const checker = new AccessChecker("1");
    const cb = vi.fn();
    // subscribe() triggers the lazy one-shot load; flush microtasks so it
    // resolves, then assert the subscriber was notified exactly once.
    checker.subscribe(cb);
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("a 403 leaves the cache empty and does not throw or notify", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({}),
      })),
    );
    const checker = new AccessChecker("1");
    const cb = vi.fn();
    checker.subscribe(cb);
    await expect(checker.load()).resolves.toBeUndefined();
    expect(checker.get(42)).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("swallows network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const checker = new AccessChecker("1");
    await expect(checker.load()).resolves.toBeUndefined();
    expect(checker.get(1)).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("ensureLoaded() fetches once; repeat calls are no-ops", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ links: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const checker = new AccessChecker("1");
    checker.ensureLoaded();
    checker.ensureLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("subscribe() triggers the lazy one-shot load", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ links: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const checker = new AccessChecker("1");
    checker.subscribe(() => {});
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("dispose() clears subscribers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ links: {} }),
      })),
    );
    const checker = new AccessChecker("1");
    const cb = vi.fn();
    checker.subscribe(cb);
    checker.dispose();
    await checker.load();
    expect(cb).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
