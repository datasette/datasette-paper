/**
 * Tests for the shared theme logic (localStorage read/write + <html> stamp).
 *
 * Mirrors the FOUC resolver in paper_base.html: the `paperTheme` key, the
 * light/dark/system whitelist, and the "anything else → light" fallback
 * (light is the default; dark/system are explicit opt-ins).
 * jsdom gives us a real `localStorage` and `document.documentElement`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// @feat dark-mode: proves the runtime toggle's read/write contract — validated
// localStorage reads (garbage/throw → "light"), setTheme persisting +
// stamping <html data-theme>, and the stable Light→Dark→System cycle order.
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
  it("returns 'light' when nothing is stored (light is the default)", () => {
    expect(getStoredTheme()).toBe("light");
  });

  it("returns a stored valid theme verbatim", () => {
    localStorage.setItem("paperTheme", "dark");
    expect(getStoredTheme()).toBe("dark");
    localStorage.setItem("paperTheme", "system");
    expect(getStoredTheme()).toBe("system");
    localStorage.setItem("paperTheme", "light");
    expect(getStoredTheme()).toBe("light");
  });

  it("falls back to 'light' for garbage values", () => {
    localStorage.setItem("paperTheme", "banana");
    expect(getStoredTheme()).toBe("light");
  });

  it("falls back to 'light' when localStorage.getItem throws", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(() => getStoredTheme()).not.toThrow();
    expect(getStoredTheme()).toBe("light");
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
  it("has the stable Light → Dark → System cycle order", () => {
    expect([...THEMES]).toEqual(["light", "dark", "system"]);
  });

  it("advances through the cycle and wraps back to the start", () => {
    expect(cycleTheme("light")).toBe("dark");
    expect(cycleTheme("dark")).toBe("system");
    expect(cycleTheme("system")).toBe("light");
  });

  it("persists and stamps the advanced value", () => {
    const next = cycleTheme("light");
    expect(next).toBe("dark");
    expect(localStorage.getItem("paperTheme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
