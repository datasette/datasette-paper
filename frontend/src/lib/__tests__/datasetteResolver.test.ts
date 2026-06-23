/**
 * Tests for DatasetteResolver: batching, caching, denied/not_found mapping,
 * and invalidate-driven re-resolution.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DatasetteResolver, type DatasetteStatus } from "../datasetteResolver";

const flush = () => new Promise((r) => setTimeout(r, 0));

function fetchReturning(refs: Record<string, DatasetteStatus>) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ refs }) }));
}

describe("DatasetteResolver", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("coalesces refs requested in one tick into a single POST", async () => {
    const f = fetchReturning({
      "/d/a": { status: "ok", kind: "table", label: "a", href: "/d/a" },
      "/d/b": { status: "denied" },
    });
    vi.stubGlobal("fetch", f);
    const r = new DatasetteResolver();
    const a: DatasetteStatus[] = [];
    const b: DatasetteStatus[] = [];
    r.request("/d/a", (s) => a.push(s));
    r.request("/d/b", (s) => b.push(s));
    await flush();

    expect(f).toHaveBeenCalledTimes(1);
    const call = f.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect([...body.refs].sort()).toEqual(["/d/a", "/d/b"]);
    expect(a[0]).toEqual({ status: "loading" });
    expect(a[1]).toEqual({ status: "ok", kind: "table", label: "a", href: "/d/a" });
    expect(b[1]).toEqual({ status: "denied" });
    r.dispose();
  });

  it("answers a cached ref synchronously without refetching", async () => {
    const f = fetchReturning({
      "/d/a": { status: "ok", kind: "table", label: "a", href: "/d/a" },
    });
    vi.stubGlobal("fetch", f);
    const r = new DatasetteResolver();
    r.request("/d/a", () => {});
    await flush();
    expect(f).toHaveBeenCalledTimes(1);

    let sync: DatasetteStatus | undefined;
    r.request("/d/a", (s) => (sync = s));
    expect(sync).toEqual({ status: "ok", kind: "table", label: "a", href: "/d/a" });
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it("maps a ref absent from the response to not_found", async () => {
    const f = fetchReturning({});
    vi.stubGlobal("fetch", f);
    const r = new DatasetteResolver();
    let last: DatasetteStatus | undefined;
    r.request("/d/x", (s) => (last = s));
    await flush();
    expect(last).toEqual({ status: "not_found" });
    r.dispose();
  });

  it("re-resolves a subscribed ref on invalidate", async () => {
    let refs: Record<string, DatasetteStatus> = {
      "/d/a": { status: "ok", kind: "table", label: "a", href: "/d/a" },
    };
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ refs }) }));
    vi.stubGlobal("fetch", f);
    const r = new DatasetteResolver();
    const seen: DatasetteStatus[] = [];
    r.request("/d/a", (s) => seen.push(s));
    await flush();

    refs = { "/d/a": { status: "denied" } };
    r.invalidate(["/d/a"]);
    await flush();
    expect(f).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toEqual({ status: "denied" });
    r.dispose();
  });

  it("does not throw or wedge when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const r = new DatasetteResolver();
    const seen: DatasetteStatus[] = [];
    r.request("/d/a", (s) => seen.push(s));
    await flush();
    // Stays "loading" (uncached) — a later invalidate can retry.
    expect(seen).toEqual([{ status: "loading" }]);
    r.dispose();
  });
});
