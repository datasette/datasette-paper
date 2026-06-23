/**
 * Tests for ActorResolver — batching, caching, subscriber notification, and
 * invalidation. Stubs the global `fetch` and drives the setTimeout(0) flush
 * with fake timers. Every test disposes its resolver so no flush timer leaks
 * into a later test (frontend/CLAUDE.md warns about leaked timers).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ActorResolver } from "../actorResolver";

function okResponse(
  actors: Record<string, { name: string; avatar_url: string | null }>,
): Response {
  return {
    ok: true,
    json: async () => ({ actors }),
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

describe("ActorResolver", () => {
  it("coalesces same-tick requests into one POST containing both ids", async () => {
    fetchMock.mockResolvedValue(okResponse({}));
    const resolver = new ActorResolver();

    resolver.request("alice", () => {});
    resolver.request("bob", () => {});

    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.ids).toContain("alice");
    expect(body.ids).toContain("bob");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
    });

    resolver.dispose();
  });

  it("notifies each subscriber with the mapped resolved status", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        alice: { name: "Alice", avatar_url: null },
        bob: { name: "Bob", avatar_url: "/avatars/bob.png" },
      }),
    );
    const resolver = new ActorResolver();

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    resolver.request("alice", cb1);
    resolver.request("bob", cb2);

    // Synchronous loading notification.
    expect(cb1).toHaveBeenCalledWith({ status: "loading" });
    expect(cb2).toHaveBeenCalledWith({ status: "loading" });

    await vi.runAllTimersAsync();

    expect(cb1).toHaveBeenLastCalledWith({
      status: "ok",
      name: "Alice",
      avatarUrl: null,
    });
    expect(cb2).toHaveBeenLastCalledWith({
      status: "ok",
      name: "Bob",
      avatarUrl: "/avatars/bob.png",
    });

    resolver.dispose();
  });

  it("answers a repeat request for a cached id synchronously with no new fetch", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ alice: { name: "Alice", avatar_url: null } }),
    );
    const resolver = new ActorResolver();

    resolver.request("alice", () => {});
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cb2 = vi.fn();
    resolver.request("alice", cb2);

    // Synchronous, from cache.
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledWith({
      status: "ok",
      name: "Alice",
      avatarUrl: null,
    });

    // No new flush scheduled.
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolver.dispose();
  });

  it("falls back to the id itself when the response omits a requested id", async () => {
    fetchMock.mockResolvedValue(okResponse({}));
    const resolver = new ActorResolver();

    const cb = vi.fn();
    resolver.request("ghost", cb);
    await vi.runAllTimersAsync();

    expect(cb).toHaveBeenLastCalledWith({
      status: "ok",
      name: "ghost",
      avatarUrl: null,
    });

    resolver.dispose();
  });

  it("does not call a cb after it unsubscribes", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ alice: { name: "Alice", avatar_url: null } }),
    );
    const resolver = new ActorResolver();

    const cb = vi.fn();
    const unsubscribe = resolver.request("alice", cb);
    cb.mockClear(); // drop the synchronous loading call

    unsubscribe();
    await vi.runAllTimersAsync();

    expect(cb).not.toHaveBeenCalled();

    resolver.dispose();
  });

  it("does not throw or wedge future flushes when a fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const resolver = new ActorResolver();

    const cb = vi.fn();
    resolver.request("alice", cb);
    await vi.runAllTimersAsync();

    // Cache untouched; a later invalidate can retry.
    fetchMock.mockResolvedValue(
      okResponse({ alice: { name: "Alice", avatar_url: null } }),
    );
    resolver.invalidate(["alice"]);
    await vi.runAllTimersAsync();

    expect(cb).toHaveBeenLastCalledWith({
      status: "ok",
      name: "Alice",
      avatarUrl: null,
    });

    resolver.dispose();
  });
});
