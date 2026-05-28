/**
 * Tests for LinkResolver — batching, caching, subscriber notification, and
 * invalidation. Stubs the global `fetch` and drives the setTimeout(0) flush
 * with fake timers. Every test disposes its resolver so no flush timer leaks
 * into a later test (frontend/CLAUDE.md warns about leaked timers).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { LinkResolver, type LinkStatus } from "../linkResolver";

function okResponse(links: Record<string, LinkStatus>): Response {
  return {
    ok: true,
    json: async () => ({ links }),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LinkResolver", () => {
  it("coalesces same-tick requests into one POST containing both ids", async () => {
    fetchMock.mockResolvedValue(okResponse({}));
    const resolver = new LinkResolver();

    resolver.request(1, () => {});
    resolver.request(2, () => {});

    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.ids).toContain(1);
    expect(body.ids).toContain(2);
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
    });

    resolver.dispose();
  });

  it("notifies each subscriber with the mapped resolved status", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        "1": {
          status: "ok",
          title: "Doc One",
          state: "active",
          kind: "paper",
          href: "/1",
        },
        "2": { status: "denied" },
      }),
    );
    const resolver = new LinkResolver();

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    resolver.request(1, cb1);
    resolver.request(2, cb2);

    // Synchronous loading notification.
    expect(cb1).toHaveBeenCalledWith({ status: "loading" });
    expect(cb2).toHaveBeenCalledWith({ status: "loading" });

    await vi.runAllTimersAsync();

    expect(cb1).toHaveBeenLastCalledWith({
      status: "ok",
      title: "Doc One",
      state: "active",
      kind: "paper",
      href: "/1",
    });
    expect(cb2).toHaveBeenLastCalledWith({ status: "denied" });

    resolver.dispose();
  });

  it("answers a repeat request for a cached id synchronously with no new fetch", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        "1": {
          status: "ok",
          title: "Doc One",
          state: "active",
          kind: "paper",
          href: "/1",
        },
      }),
    );
    const resolver = new LinkResolver();

    resolver.request(1, () => {});
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cb2 = vi.fn();
    resolver.request(1, cb2);

    // Synchronous, from cache.
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledWith({
      status: "ok",
      title: "Doc One",
      state: "active",
      kind: "paper",
      href: "/1",
    });

    // No new flush scheduled.
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolver.dispose();
  });

  it("re-resolves an id after invalidate", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        "1": {
          status: "ok",
          title: "Doc One",
          state: "active",
          kind: "paper",
          href: "/1",
        },
      }),
    );
    const resolver = new LinkResolver();

    const cb = vi.fn();
    resolver.request(1, cb);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolver.invalidate([1]);
    expect(cb).toHaveBeenLastCalledWith({ status: "loading" });

    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolver.dispose();
  });

  it("does not call a cb after it unsubscribes", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        "1": {
          status: "ok",
          title: "Doc One",
          state: "active",
          kind: "paper",
          href: "/1",
        },
      }),
    );
    const resolver = new LinkResolver();

    const cb = vi.fn();
    const unsubscribe = resolver.request(1, cb);
    cb.mockClear(); // drop the synchronous loading call

    unsubscribe();
    await vi.runAllTimersAsync();

    expect(cb).not.toHaveBeenCalled();

    resolver.dispose();
  });

  it("resolves a requested-but-absent id to not_found", async () => {
    fetchMock.mockResolvedValue(okResponse({}));
    const resolver = new LinkResolver();

    const cb = vi.fn();
    resolver.request(99, cb);
    await vi.runAllTimersAsync();

    expect(cb).toHaveBeenLastCalledWith({ status: "not_found" });

    resolver.dispose();
  });

  it("does not throw or wedge future flushes when a fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const resolver = new LinkResolver();

    const cb = vi.fn();
    resolver.request(1, cb);
    await vi.runAllTimersAsync();

    // Cache untouched; a later invalidate can retry.
    fetchMock.mockResolvedValue(
      okResponse({
        "1": {
          status: "ok",
          title: "Doc One",
          state: "active",
          kind: "paper",
          href: "/1",
        },
      }),
    );
    resolver.invalidate([1]);
    await vi.runAllTimersAsync();

    expect(cb).toHaveBeenLastCalledWith({
      status: "ok",
      title: "Doc One",
      state: "active",
      kind: "paper",
      href: "/1",
    });

    resolver.dispose();
  });
});
