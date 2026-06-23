/**
 * Unit tests for the lazy provider loader (embedProviders.ts): manifest →
 * ref-prefix matching, on-demand bundle injection, idempotency, and the
 * already-registered / absent short-circuits.
 *
 * jsdom does not execute injected `<script src>`, so the injection tests assert
 * the DOM mutation synchronously (without awaiting the load promise, which only
 * settles on a real `onload`). The already-registered/absent paths resolve
 * synchronously, so those are awaited.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  setProviderManifest,
  manifestKindForRef,
  manifestEntryForRef,
  ensureProvider,
  ensureProviderForRef,
  _resetProvidersForTest,
} from "../embedProviders";
import { embedRegistry } from "../embedRegistry";

afterEach(() => {
  delete window.datasettePaperEmbeds;
  _resetProvidersForTest();
  document
    .querySelectorAll('script[src], link[rel="stylesheet"]')
    .forEach((el) => el.remove());
});

describe("manifest ref matching", () => {
  it("maps a ref to the owning provider kind by prefix", () => {
    setProviderManifest([
      { kind: "places", ref_prefixes: ["/-/places/"] },
      { kind: "sheet", ref_prefixes: ["/-/sheets/", "/-/grid/"] },
    ]);
    expect(manifestKindForRef("/-/places/list/5")).toBe("places");
    expect(manifestKindForRef("/-/grid/abc")).toBe("sheet");
    expect(manifestKindForRef("/data/vendors")).toBeUndefined();
    expect(manifestEntryForRef("/-/places/list/5")?.kind).toBe("places");
  });

  it("treats a missing/empty manifest as owning nothing", () => {
    setProviderManifest(undefined);
    expect(manifestKindForRef("/-/places/list/5")).toBeUndefined();
  });
});

describe("ensureProvider", () => {
  it("injects the bundle's <script> + <link> on first ensure", () => {
    setProviderManifest([
      { kind: "places", js: ["/places.js"], css: ["/places.css"], ref_prefixes: ["/-/places/"] },
    ]);
    // Not awaited: the load promise only settles on a real onload (absent in jsdom).
    void ensureProvider("places");
    expect(document.querySelector('script[src="/places.js"]')).not.toBeNull();
    expect(document.querySelector('link[href="/places.css"]')).not.toBeNull();
  });

  it("does not double-inject on repeated ensure", () => {
    setProviderManifest([{ kind: "places", js: ["/places.js"] }]);
    void ensureProvider("places");
    void ensureProvider("places");
    expect(document.querySelectorAll('script[src="/places.js"]').length).toBe(1);
  });

  it("resolves immediately and injects nothing when already registered", async () => {
    setProviderManifest([{ kind: "places", js: ["/places.js"] }]);
    embedRegistry().register({ kind: "places", mount: () => {} });
    await ensureProvider("places");
    expect(document.querySelector('script[src="/places.js"]')).toBeNull();
  });

  it("is a no-op for a kind absent from the manifest", async () => {
    setProviderManifest([]);
    await ensureProvider("nope");
    expect(document.querySelector("script[src]")).toBeNull();
  });

  it("ensureProviderForRef injects the provider that owns the ref", () => {
    setProviderManifest([
      { kind: "places", js: ["/places.js"], ref_prefixes: ["/-/places/"] },
    ]);
    void ensureProviderForRef("/-/places/list/5");
    expect(document.querySelector('script[src="/places.js"]')).not.toBeNull();
  });

  it("ensureProviderForRef is a no-op for an unclaimed ref", async () => {
    setProviderManifest([
      { kind: "places", js: ["/places.js"], ref_prefixes: ["/-/places/"] },
    ]);
    await ensureProviderForRef("/data/vendors");
    expect(document.querySelector("script[src]")).toBeNull();
  });
});
