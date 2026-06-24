/**
 * Unit tests for the lazy provider loader (embedProviders.ts): manifest →
 * ref-prefix matching, on-demand bundle import + registration, idempotency,
 * and the already-registered / absent short-circuits.
 *
 * A bundle is an ES module whose `export default` is a provider; jsdom can't
 * fetch a real bundle URL, so `_setModuleImporterForTest` stubs the dynamic
 * `import()` and the tests assert that the default export gets registered.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  setProviderManifest,
  manifestKindForRef,
  manifestEntryForRef,
  ensureProvider,
  ensureProviderForRef,
  _resetProvidersForTest,
  _setModuleImporterForTest,
} from "../embedProviders";
import { embedRegistry } from "../embedRegistry";
import type { PaperEmbedProvider } from "../embedRegistry";

afterEach(() => {
  _resetProvidersForTest(); // also resets the importer + the shared registry
  document
    .querySelectorAll('link[rel="stylesheet"]')
    .forEach((el) => el.remove());
});

/** A minimal well-formed provider for a given kind. */
function fakeProvider(kind: string): PaperEmbedProvider {
  return { kind, mount: () => {} };
}

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
  it("imports the bundle and registers its default-exported provider", async () => {
    setProviderManifest([
      { kind: "places", js: ["/places.js"], ref_prefixes: ["/-/places/"] },
    ]);
    const provider = fakeProvider("places");
    _setModuleImporterForTest(async () => ({ default: provider }));
    await ensureProvider("places");
    expect(embedRegistry().get("places")).toBe(provider);
  });

  it("registers a default-exported factory's result", async () => {
    setProviderManifest([{ kind: "places", js: ["/places.js"] }]);
    const provider = fakeProvider("places");
    _setModuleImporterForTest(async () => ({ default: () => provider }));
    await ensureProvider("places");
    expect(embedRegistry().get("places")).toBe(provider);
  });

  it("registers every provider when the default export is an array", async () => {
    setProviderManifest([{ kind: "places", js: ["/multi.js"] }]);
    const a = fakeProvider("places");
    const b = fakeProvider("sheet");
    _setModuleImporterForTest(async () => ({ default: [a, b] }));
    await ensureProvider("places");
    expect(embedRegistry().get("places")).toBe(a);
    expect(embedRegistry().get("sheet")).toBe(b);
  });

  it("injects the bundle's CSS as a <link>", async () => {
    setProviderManifest([{ kind: "places", js: ["/places.js"], css: ["/places.css"] }]);
    _setModuleImporterForTest(async () => ({ default: fakeProvider("places") }));
    await ensureProvider("places");
    expect(document.querySelector('link[href="/places.css"]')).not.toBeNull();
  });

  it("imports a bundle only once across repeated ensures", async () => {
    setProviderManifest([{ kind: "places", js: ["/places.js"] }]);
    const importer = vi.fn(async () => ({ default: fakeProvider("places") }));
    _setModuleImporterForTest(importer);
    await ensureProvider("places");
    await ensureProvider("places");
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("resolves immediately and imports nothing when already registered", async () => {
    setProviderManifest([{ kind: "places", js: ["/places.js"] }]);
    const importer = vi.fn(async () => ({ default: fakeProvider("places") }));
    _setModuleImporterForTest(importer);
    embedRegistry().register(fakeProvider("places"));
    await ensureProvider("places");
    expect(importer).not.toHaveBeenCalled();
  });

  it("degrades (no throw, no registration) when the import fails", async () => {
    setProviderManifest([{ kind: "places", js: ["/places.js"] }]);
    _setModuleImporterForTest(async () => {
      throw new Error("network");
    });
    await expect(ensureProvider("places")).resolves.toBeUndefined();
    expect(embedRegistry().get("places")).toBeUndefined();
  });

  it("ignores a malformed default export", async () => {
    setProviderManifest([{ kind: "places", js: ["/places.js"] }]);
    // A provider missing `mount` — well-typed away, but a real bundle could ship it.
    const malformed = { kind: "places" } as unknown as PaperEmbedProvider;
    _setModuleImporterForTest(async () => ({ default: malformed }));
    await ensureProvider("places");
    expect(embedRegistry().get("places")).toBeUndefined();
  });

  it("is a no-op for a kind absent from the manifest", async () => {
    setProviderManifest([]);
    const importer = vi.fn(async () => ({ default: fakeProvider("nope") }));
    _setModuleImporterForTest(importer);
    await ensureProvider("nope");
    expect(importer).not.toHaveBeenCalled();
  });

  it("ensureProviderForRef imports the provider that owns the ref", async () => {
    setProviderManifest([
      { kind: "places", js: ["/places.js"], ref_prefixes: ["/-/places/"] },
    ]);
    const provider = fakeProvider("places");
    _setModuleImporterForTest(async () => ({ default: provider }));
    await ensureProviderForRef("/-/places/list/5");
    expect(embedRegistry().get("places")).toBe(provider);
  });

  it("ensureProviderForRef is a no-op for an unclaimed ref", async () => {
    setProviderManifest([
      { kind: "places", js: ["/places.js"], ref_prefixes: ["/-/places/"] },
    ]);
    const importer = vi.fn(async () => ({ default: fakeProvider("places") }));
    _setModuleImporterForTest(importer);
    await ensureProviderForRef("/data/vendors");
    expect(importer).not.toHaveBeenCalled();
  });
});
