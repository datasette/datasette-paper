/**
 * Theme contrast gate — ticket plans/dark/tickets/03-contrast-gate.md.
 *
 * Parses the `--pp-*` semantic-palette token blocks out of
 * `frontend/src/app.css` and asserts WCAG 2.x AA contrast on every
 * text-on-surface pairing, *per theme*. Theme-aware from day one: it
 * discovers whichever `:root`-ish blocks the CSS actually declares, so
 * when ticket 04 adds a `:root[data-theme="dark"]` block the dark palette
 * is gated automatically with ZERO changes to this file (tokens dark
 * doesn't override fall back to the light value).
 *
 * The contrast math (hex/rgb -> linear-RGB -> relative luminance -> ratio)
 * is implemented here rather than pulled from a dependency; it's ~30 lines
 * and unit-checked below against two anchor ratios.
 */
// tsconfig.app.json pins `types` to ["svelte","vite/client"], so the node
// builtins below need an explicit reference to load @types/node's decls.
/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// --- read the CSS off disk, relative to THIS test file -------------------
// NB: the jsdom test environment swaps the global `URL` for its own
// implementation whose base is http://localhost, so `new URL(rel, meta)`
// would resolve against that, not the file://. Convert import.meta.url (a
// plain file:// string) to a path first, then resolve with node:path.
const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, "../../app.css");
const cssText = readFileSync(cssPath, "utf8");

// --- WCAG 2.x contrast math ----------------------------------------------
type RGB = { r: number; g: number; b: number };
type RGBA = RGB & { a: number };

/** Parse a CSS color literal: 3/4/6/8-digit hex or rgb()/rgba(). */
function parseColor(input: string): RGBA {
  const s = input.trim();
  let m = s.match(/^#([0-9a-fA-F]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    if (h.length === 6) h += "ff";
    if (h.length !== 8) throw new Error(`bad hex color: ${input}`);
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: parseInt(h.slice(6, 8), 16) / 255,
    };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,/]/).map((p) => p.trim());
    const chan = (v: string) =>
      v.endsWith("%") ? (parseFloat(v) / 100) * 255 : parseFloat(v);
    const [r, g, b, a] = parts;
    return {
      r: chan(r),
      g: chan(g),
      b: chan(b),
      a: a === undefined ? 1 : a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a),
    };
  }
  throw new Error(`unrecognized color: ${input}`);
}

/** Alpha-composite `fg` (source-over) onto an opaque `bg`. */
function composite(fg: RGBA, bg: RGB): RGB {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

/** WCAG relative luminance from an 8-bit-per-channel opaque color. */
function relativeLuminance({ r, g, b }: RGB): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two opaque colors (order-independent). */
function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// --- dumb parser: `:root`-ish token blocks -> theme -> token map ---------
// Selector -> theme name. `:root` = light (base); `:root[data-theme="dark"]`
// = dark. Any other `:root[...]` selector is ignored (not a palette theme).
function themeForSelector(sel: string): string | null {
  const s = sel.trim();
  if (s === ":root") return "light";
  const m = s.match(/^:root\[data-theme=["']?([a-z0-9-]+)["']?\]$/i);
  return m ? m[1] : null;
}

/** Strip `/* ... *\/` comments, then regex out every `:root`-ish block. */
function parseThemes(css: string): Record<string, Record<string, string>> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const themes: Record<string, Record<string, string>> = {};
  const blockRe = /(:root(?:\[[^\]]*\])?)\s*\{([^}]*)\}/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(noComments))) {
    const theme = themeForSelector(block[1]);
    if (!theme) continue;
    const tokens: Record<string, string> = (themes[theme] ??= {});
    const declRe = /(--pp-[\w-]+)\s*:\s*([^;]+);/g;
    let decl: RegExpExecArray | null;
    while ((decl = declRe.exec(block[2]))) {
      tokens[decl[1]] = decl[2].trim();
    }
  }
  return themes;
}

const parsed = parseThemes(cssText);
const themeNames = Object.keys(parsed);
// Effective palette per theme: dark (and any future theme) inherits light's
// tokens for anything it doesn't override; light is the base.
const light = parsed.light ?? {};
function paletteFor(theme: string): Record<string, string> {
  return theme === "light" ? light : { ...light, ...parsed[theme] };
}

/** Resolve a token to an opaque color, compositing washes over `--pp-bg`. */
function resolveToken(palette: Record<string, string>, token: string): RGB {
  const raw = palette[token];
  if (raw === undefined) throw new Error(`missing token: ${token}`);
  const c = parseColor(raw);
  if (c.a >= 1) return c;
  const bg = parseColor(palette["--pp-bg"]);
  return composite(c, bg);
}

// --- pairing table (verbatim from the ticket / plans/dark/04-accessibility.md)
// AA = 4.5:1 body text, 3:1 large text / UI boundaries. `note` documents any
// pairing whose threshold is NOT the 4.5 body-text number.
type Pairing = { fg: string; bg: string; min: number; note?: string };
const PAIRINGS: Pairing[] = [
  { fg: "--pp-fg", bg: "--pp-bg", min: 4.5 },
  { fg: "--pp-fg", bg: "--pp-surface", min: 4.5 },
  { fg: "--pp-fg", bg: "--pp-surface-2", min: 4.5 },
  { fg: "--pp-fg", bg: "--pp-surface-3", min: 4.5 },
  { fg: "--pp-fg-muted", bg: "--pp-bg", min: 4.5 },
  { fg: "--pp-fg-muted", bg: "--pp-surface", min: 4.5 },
  {
    fg: "--pp-fg-subtle",
    bg: "--pp-bg",
    min: 3.0,
    // Placeholder / hint text. WCAG exempts "inactive/placeholder" text from
    // the 4.5 body-text floor; we still hold it to the 3:1 large-text bar so
    // it can't fade into the page.
  },
  { fg: "--pp-accent-fg", bg: "--pp-accent", min: 4.5 },
  { fg: "--pp-link", bg: "--pp-bg", min: 4.5 },
  { fg: "--pp-danger", bg: "--pp-bg", min: 4.5 },
  // danger/warn washes are translucent-or-tinted surfaces: resolveToken
  // composites them over --pp-bg before measuring.
  { fg: "--pp-danger", bg: "--pp-danger-bg", min: 4.5 },
  { fg: "--pp-warn", bg: "--pp-bg", min: 4.5 },
  { fg: "--pp-warn", bg: "--pp-warn-bg", min: 4.5 },
  {
    fg: "--pp-accent",
    bg: "--pp-bg",
    min: 3.0,
    // UI boundary / icon use, not body text -> 3:1 large-text/non-text bar.
  },
  {
    fg: "--pp-focus-ring",
    bg: "--pp-bg",
    min: 3.0,
    // Focus indicator is a non-text UI component -> WCAG 1.4.11 3:1.
  },
  { fg: "--pp-focus-ring", bg: "--pp-surface", min: 3.0 },
  {
    fg: "--pp-border",
    bg: "--pp-bg",
    min: 1.5,
    // NOT a WCAG number. Hairlines/dividers are decorative; this is just a
    // visibility floor so a theme can't ship a border that vanishes into bg.
  },
];

function pairKey(theme: string, p: Pairing): string {
  return `${theme}: ${p.fg} on ${p.bg}`;
}

// --- KNOWN_FAILURES: shrink-only ledger ----------------------------------
// Existing palette values that currently fail their pairing. Keyed
// (theme, pairing) -> the measured ratio at the time it was recorded. This
// list is asserted to match the CURRENT set of failures exactly, so:
//   * a NEW failure (regression) -> red build (not in the ledger)
//   * a listed entry that starts PASSING -> red build (stale; must be removed)
// Ticket 04's palette-tuning pass has to burn these down to empty.
const KNOWN_FAILURES: Record<string, number> = {
  // #d4d4d4 border on #fff bg == 1.48:1, just under the 1.5 visibility floor.
  "light: --pp-border on --pp-bg": 1.48,
};

// -------------------------------------------------------------------------

describe("contrast math (self-check)", () => {
  it("black on white is exactly 21:1", () => {
    expect(contrastRatio(parseColor("#000"), parseColor("#fff"))).toBeCloseTo(
      21,
      5,
    );
  });

  it("#767676 on white is ~4.54:1 (WCAG AA reference gray)", () => {
    expect(
      contrastRatio(parseColor("#767676"), parseColor("#ffffff")),
    ).toBeCloseTo(4.54, 2);
  });

  it("parses 3/4/6/8-digit hex and rgb()/rgba() equivalently", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#ffffffff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#0000")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor("rgb(11, 92, 173)")).toEqual({
      r: 11,
      g: 92,
      b: 173,
      a: 1,
    });
    expect(parseColor("rgba(11, 92, 173, 0.08)").a).toBeCloseTo(0.08, 5);
  });

  it("composites a translucent wash over its base surface", () => {
    // rgba(0,0,0,0.5) over white == mid gray (#808080-ish).
    const c = composite(parseColor("rgba(0,0,0,0.5)"), parseColor("#fff"));
    expect(c.r).toBeCloseTo(127.5, 5);
  });
});

describe("theme token parser", () => {
  it("finds at least one theme (light base is always present)", () => {
    expect(themeNames).toContain("light");
  });

  it("parsed >= 20 --pp-* tokens from the base block (parser didn't no-op)", () => {
    // Guards against a refactor moving/renaming the token block and silently
    // turning the whole gate into a pass-over-nothing.
    expect(Object.keys(light).length).toBeGreaterThanOrEqual(20);
  });

  it("every pairing token exists in the base palette", () => {
    const needed = new Set(PAIRINGS.flatMap((p) => [p.fg, p.bg]));
    for (const token of needed) expect(light).toHaveProperty(token);
  });
});

describe("WCAG AA contrast per theme", () => {
  it("current failures match KNOWN_FAILURES exactly (shrink-only)", () => {
    const failing: string[] = [];
    for (const theme of themeNames) {
      const palette = paletteFor(theme);
      for (const p of PAIRINGS) {
        const ratio = contrastRatio(
          resolveToken(palette, p.fg),
          resolveToken(palette, p.bg),
        );
        if (ratio < p.min) failing.push(pairKey(theme, p));
      }
    }
    // Exact match catches BOTH new regressions and now-passing stale entries.
    expect(failing.sort()).toEqual(Object.keys(KNOWN_FAILURES).sort());
  });

  it("each KNOWN_FAILURES entry is genuinely failing at its recorded ratio", () => {
    for (const [key, recorded] of Object.entries(KNOWN_FAILURES)) {
      const [theme, rest] = key.split(": ");
      const [fg, bg] = rest.split(" on ");
      const palette = paletteFor(theme);
      const pairing = PAIRINGS.find((p) => p.fg === fg && p.bg === bg);
      expect(pairing, `no pairing declared for "${key}"`).toBeDefined();
      const ratio = contrastRatio(
        resolveToken(palette, fg),
        resolveToken(palette, bg),
      );
      expect(ratio).toBeLessThan(pairing!.min);
      expect(ratio).toBeCloseTo(recorded, 2);
    }
  });

  // Per-theme, per-pairing table so a failure names the exact offender.
  for (const theme of themeNames) {
    describe(`${theme} palette`, () => {
      const palette = paletteFor(theme);
      for (const p of PAIRINGS) {
        const key = pairKey(theme, p);
        const known = key in KNOWN_FAILURES;
        it(`${p.fg} on ${p.bg} >= ${p.min}:1${known ? " (known failure)" : ""}`, () => {
          const ratio = contrastRatio(
            resolveToken(palette, p.fg),
            resolveToken(palette, p.bg),
          );
          if (known) expect(ratio).toBeLessThan(p.min);
          else expect(ratio).toBeGreaterThanOrEqual(p.min);
        });
      }
    });
  }
});
