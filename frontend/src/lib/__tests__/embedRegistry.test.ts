/**
 * Tests for the third-party embed JS API registry.
 */
import { describe, it, expect, afterEach } from "vitest";
import { embedRegistry, makeEmbedRegistry } from "../embedRegistry";

afterEach(() => {
  delete window.datasettePaperEmbeds;
});

describe("embedRegistry", () => {
  it("is a singleton on window, created on first access", () => {
    const a = embedRegistry();
    const b = embedRegistry();
    expect(a).toBe(b);
    expect(window.datasettePaperEmbeds).toBe(a);
  });

  it("registers and looks up renderers by kind", () => {
    const reg = makeEmbedRegistry();
    const renderer = { kind: "place-list", mount: () => {} };
    reg.register(renderer);
    expect(reg.get("place-list")).toBe(renderer);
    expect(reg.get("nope")).toBeUndefined();
    expect(reg.all()).toEqual([renderer]);
  });

  it("matches a URL via the first renderer that claims it", () => {
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
