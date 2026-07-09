/**
 * Tests for the shared theme logic (localStorage read/write + <html> stamp).
 *
 * Mirrors the FOUC resolver in paper_base.html: the `paperTheme` key, the
 * light/dark/system whitelist, and the "anything else → system" fallback.
 * jsdom gives us a real `localStorage` and `document.documentElement`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// @feat dark-mode: proves the runtime toggle's read/write contract — validated
// localStorage reads (garbage/throw → "system"), setTheme persisting +
// stamping <html data-theme>, and the stable System→Light→Dark cycle order.
import {
  THEMES,
  getStoredTheme,
  applyTheme,
  setTheme,
  cycleTheme,
} from "../theme";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getStoredTheme", () => {
  it("returns 'system' when nothing is stored", () => {
    expect(getStoredTheme()).toBe("system");
  });

  it("returns a stored valid theme verbatim", () => {
    localStorage.setItem("paperTheme", "dark");
    expect(getStoredTheme()).toBe("dark");
    localStorage.setItem("paperTheme", "light");
    expect(getStoredTheme()).toBe("light");
  });

  it("falls back to 'system' for garbage values", () => {
    localStorage.setItem("paperTheme", "banana");
    expect(getStoredTheme()).toBe("system");
  });

  it("falls back to 'system' when localStorage.getItem throws", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(() => getStoredTheme()).not.toThrow();
    expect(getStoredTheme()).toBe("system");
    expect(spy).toHaveBeenCalled();
  });
});

describe("applyTheme", () => {
  it("stamps the theme on <html data-theme>", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("setTheme", () => {
  it("persists the choice and stamps <html>", () => {
    setTheme("light");
    expect(localStorage.getItem("paperTheme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("swallows a throwing localStorage.setItem but still stamps <html>", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    expect(() => setTheme("dark")).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(spy).toHaveBeenCalled();
  });
});

describe("cycleTheme / THEMES", () => {
  it("has the stable System → Light → Dark cycle order", () => {
    expect([...THEMES]).toEqual(["system", "light", "dark"]);
  });

  it("advances through the cycle and wraps back to the start", () => {
    expect(cycleTheme("system")).toBe("light");
    expect(cycleTheme("light")).toBe("dark");
    expect(cycleTheme("dark")).toBe("system");
  });

  it("persists and stamps the advanced value", () => {
    const next = cycleTheme("system");
    expect(next).toBe("light");
    expect(localStorage.getItem("paperTheme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
