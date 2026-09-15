/**
 * Display-text tests for the shortcut registry + formatter. These prove hint
 * strings only — binding behaviour lives in `shortcutBindings.test.ts`.
 * Expected strings are hand-written literals, never derived from the parser.
 */
import { describe, it, expect } from "vitest";
import { IS_MAC } from "../platform";
import {
  SHORTCUTS,
  ariaKeyshortcuts,
  formatShortcut,
  parseShortcut,
  titleWithShortcut,
  type ShortcutId,
} from "../shortcuts";

describe("formatShortcut", () => {
  const rows: [string, string, string][] = [
    ["Mod-b", "⌘B", "Ctrl+B"],
    ["Mod-Shift-x", "⇧⌘X", "Ctrl+Shift+X"],
    ["Shift-Mod-z", "⇧⌘Z", "Ctrl+Shift+Z"],
    ["Shift-Ctrl-1", "⌃⇧1", "Ctrl+Shift+1"],
    ["Ctrl->", "⌃>", "Ctrl+>"],
    ["Shift-Ctrl-\\", "⌃⇧\\", "Ctrl+Shift+\\"],
    ["Mod-`", "⌘`", "Ctrl+`"],
    ["Mod-;", "⌘;", "Ctrl+;"],
    ["Mod-Shift-;", "⇧⌘;", "Ctrl+Shift+;"],
    ["Mod-]", "⌘]", "Ctrl+]"],
    ["Mod-[", "⌘[", "Ctrl+["],
    ["Mod-_", "⌘_", "Ctrl+_"],
    ["Mod-Enter", "⌘↵", "Ctrl+Enter"],
    ["Tab", "⇥", "Tab"],
    ["Shift-Tab", "⇧⇥", "Shift+Tab"],
    ["Alt-ArrowUp", "⌥↑", "Alt+↑"],
    ["Ctrl-Alt-Shift-Cmd-k", "⌃⌥⇧⌘K", "Ctrl+Alt+Shift+Meta+K"],
  ];
  for (const [key, mac, other] of rows) {
    it(`${key} → ${mac} / ${other}`, () => {
      expect(formatShortcut(key, true)).toBe(mac);
      expect(formatShortcut(key, false)).toBe(other);
    });
  }
});

describe("ariaKeyshortcuts", () => {
  it("uses WAI-ARIA modifier names, platform-resolved Mod", () => {
    expect(ariaKeyshortcuts("Mod-Shift-x", true)).toBe("Meta+Shift+X");
    expect(ariaKeyshortcuts("Mod-Shift-x", false)).toBe("Control+Shift+X");
    expect(ariaKeyshortcuts("Ctrl->", true)).toBe("Control+>");
    expect(ariaKeyshortcuts("Ctrl->", false)).toBe("Control+>");
    expect(ariaKeyshortcuts("Mod-Enter", true)).toBe("Meta+Enter");
    expect(ariaKeyshortcuts("Mod-Enter", false)).toBe("Control+Enter");
  });
});

describe("titleWithShortcut", () => {
  it("appends the registry chord", () => {
    expect(titleWithShortcut("Bold", "bold", true)).toBe("Bold (⌘B)");
    expect(titleWithShortcut("Bold", "bold", false)).toBe("Bold (Ctrl+B)");
  });
});

describe("parseShortcut", () => {
  it("handles a trailing - / _ key", () => {
    expect(parseShortcut("Mod-_")).toMatchObject({ key: "_", mod: true });
    expect(parseShortcut("Mod--")).toMatchObject({ key: "-", mod: true });
  });
  it("is case-insensitive on modifiers", () => {
    expect(parseShortcut("mod-B")).toEqual({
      key: "B",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      mod: true,
    });
  });
  it("maps Space to a space key", () => {
    expect(parseShortcut("Shift-Space")).toMatchObject({
      key: " ",
      shift: true,
    });
  });
  it("throws on an unknown modifier, like prosemirror-keymap", () => {
    expect(() => parseShortcut("Hyper-x")).toThrow(/Unrecognized modifier/);
  });
});

describe("SHORTCUTS registry", () => {
  const ids = Object.keys(SHORTCUTS) as ShortcutId[];

  it("every key parses", () => {
    for (const id of ids) expect(() => parseShortcut(SHORTCUTS[id].key)).not.toThrow();
  });

  it("no two entries on the same surface share a normalised chord", () => {
    const seen = new Map<string, ShortcutId>();
    for (const id of ids) {
      const def = SHORTCUTS[id];
      const p = parseShortcut(def.key);
      const norm = [
        def.surface,
        p.ctrl || p.mod, // mod resolved for mac=false
        p.meta,
        p.alt,
        p.shift,
        p.key.toLowerCase(),
      ].join("|");
      expect(seen.get(norm), `${id} collides with ${seen.get(norm)}`).toBe(
        undefined,
      );
      seen.set(norm, id);
    }
  });

  it("every entry has a label and valid surface/owner", () => {
    for (const id of ids) {
      const def = SHORTCUTS[id];
      expect(def.label.length).toBeGreaterThan(0);
      expect(["prose", "sql"]).toContain(def.surface);
      expect(["paper", "upstream"]).toContain(def.owner);
    }
  });
});

describe("platform", () => {
  it("IS_MAC is false under jsdom (navigator.platform is empty)", () => {
    expect(navigator.platform).toBe("");
    expect(IS_MAC).toBe(false);
  });
});
