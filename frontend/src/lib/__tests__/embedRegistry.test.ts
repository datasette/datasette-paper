/**
 * Tests for the third-party embed JS API registry.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  embedRegistry,
  makeEmbedRegistry,
  _resetEmbedRegistryForTest,
} from "../embedRegistry";

afterEach(() => {
  _resetEmbedRegistryForTest();
});

describe("embedRegistry", () => {
  it("returns a stable singleton across calls", () => {
    const a = embedRegistry();
    const b = embedRegistry();
    expect(a).toBe(b);
  });

  it("hands out a fresh registry after a reset", () => {
    const a = embedRegistry();
    _resetEmbedRegistryForTest();
    expect(embedRegistry()).not.toBe(a);
  });

  it("registers and looks up providers by kind", () => {
    const reg = makeEmbedRegistry();
    const provider = { kind: "place-list", mount: () => {} };
    reg.register(provider);
    expect(reg.get("place-list")).toBe(provider);
    expect(reg.get("nope")).toBeUndefined();
    expect(reg.all()).toEqual([provider]);
  });

  it("re-registering the same kind replaces the prior provider", () => {
    const reg = makeEmbedRegistry();
    const first = { kind: "place-list", mount: () => {} };
    const second = { kind: "place-list", mount: () => {} };
    reg.register(first);
    reg.register(second);
    expect(reg.get("place-list")).toBe(second);
    expect(reg.all()).toEqual([second]);
  });

  it("finds the provider that claims a ref via matchRef", () => {
    const reg = makeEmbedRegistry();
    const places = {
      kind: "place-list",
      matchRef: (ref: string) => ref.startsWith("/-/places/list/"),
      mount: () => {},
    };
    reg.register(places);
    expect(reg.providerForRef("/-/places/list/7")).toBe(places);
    expect(reg.providerForRef("/data/vendors")).toBeUndefined();
  });

  it("matches a URL via the first provider that claims it", () => {
    const reg = makeEmbedRegistry();
    reg.register({
      kind: "place-list",
      matchUrl: (url) => {
        const m = url.pathname.match(/^\/-\/places\/list\/(\d+)$/);
        return m ? `/-/places/list/${m[1]}` : null;
      },
      mount: () => {},
    });
    expect(reg.match(new URL("https://x.test/-/places/list/7"))).toBe(
      "/-/places/list/7",
    );
    expect(reg.match(new URL("https://x.test/data/vendors"))).toBeNull();
  });
});
