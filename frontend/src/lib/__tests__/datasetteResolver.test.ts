/**
 * Tests for DatasetteResolver: per-ref fan-out, caching, invalidate-driven
 * re-resolution, and the transient-failure (stay-loading) path — plus
 * `resolveRef`'s native-JSON URL + status mapping.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DatasetteResolver,
  resolveRef,
  type DatasetteStatus,
} from "../datasetteResolver";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("DatasetteResolver", () => {
  it("resolves each ref requested in one tick via its own lookup", async () => {
    const resolve = vi.fn(async (ref: string): Promise<DatasetteStatus> =>
      ref === "/d/a"
        ? { status: "ok", kind: "table", label: "a", href: "/d/a" }
        : { status: "denied" },
    );
    const r = new DatasetteResolver(resolve);
    const a: DatasetteStatus[] = [];
    const b: DatasetteStatus[] = [];
    r.request("/d/a", (s) => a.push(s));
    r.request("/d/b", (s) => b.push(s));
    await flush();

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls.map((c) => c[0]).sort()).toEqual(["/d/a", "/d/b"]);
    expect(a[0]).toEqual({ status: "loading" });
    expect(a[1]).toEqual({ status: "ok", kind: "table", label: "a", href: "/d/a" });
    expect(b[1]).toEqual({ status: "denied" });
    r.dispose();
  });

  it("answers a cached ref synchronously without re-resolving", async () => {
    const resolve = vi.fn(async (): Promise<DatasetteStatus> => ({
      status: "ok",
      kind: "table",
      label: "a",
      href: "/d/a",
    }));
    const r = new DatasetteResolver(resolve);
    r.request("/d/a", () => {});
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);

    let sync: DatasetteStatus | undefined;
    r.request("/d/a", (s) => (sync = s));
    expect(sync).toEqual({ status: "ok", kind: "table", label: "a", href: "/d/a" });
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it("re-resolves a subscribed ref on invalidate", async () => {
    let status: DatasetteStatus = { status: "ok", kind: "table", label: "a", href: "/d/a" };
    const resolve = vi.fn(async (): Promise<DatasetteStatus> => status);
    const r = new DatasetteResolver(resolve);
    const seen: DatasetteStatus[] = [];
    r.request("/d/a", (s) => seen.push(s));
    await flush();

    status = { status: "denied" };
    r.invalidate(["/d/a"]);
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toEqual({ status: "denied" });
    r.dispose();
  });

  it("does not cache a transient (null) failure — stays loading, retriable", async () => {
    const resolve = vi.fn(async (): Promise<DatasetteStatus | null> => null);
    const r = new DatasetteResolver(resolve);
    const seen: DatasetteStatus[] = [];
    r.request("/d/a", (s) => seen.push(s));
    await flush();
    expect(seen).toEqual([{ status: "loading" }]);
    // Uncached → a later invalidate re-attempts the lookup.
    r.invalidate(["/d/a"]);
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
    r.dispose();
  });
});

describe("resolveRef (native .json)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves a table to ok with a count via /<db>/<table>.json?_size=0", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ count: 30 }) };
      }),
    );
    expect(await resolveRef("/d/t")).toEqual({
      status: "ok",
      kind: "table",
      label: "t",
      href: "/d/t",
      db: "d",
      count: 30,
    });
    expect(urls[0]).toBe("/d/t.json?_size=0&_extra=count");
  });

  it("resolves a database and a row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    expect(await resolveRef("/d")).toEqual({
      status: "ok",
      kind: "database",
      label: "d",
      href: "/d",
      db: "d",
    });
    expect(await resolveRef("/d/t/5")).toEqual({
      status: "ok",
      kind: "row",
      label: "5",
      href: "/d/t/5",
      db: "d",
      table: "t",
      pk: "5",
    });
  });

  it("maps 403 → denied, 404 → not_found, other → null (transient)", async () => {
    const withStatus = (status: number) =>
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, json: async () => ({}) })));
    withStatus(403);
    expect(await resolveRef("/d/t")).toEqual({ status: "denied" });
    withStatus(404);
    expect(await resolveRef("/d/t")).toEqual({ status: "not_found" });
    withStatus(500);
    expect(await resolveRef("/d/t")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    expect(await resolveRef("/d/t")).toBeNull();
  });
});
