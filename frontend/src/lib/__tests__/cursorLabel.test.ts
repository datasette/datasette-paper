/**
 * Contrast contract for remote-presence cursor labels (cursors.ts).
 *
 * `labelColorFor` picks the label text color from a hue's WCAG relative
 * luminance: near-black on the light palette hues (lime/pink/cyan, which
 * white text is unreadable on), white on the dark ones. Table-driven over
 * the real 12-color PALETTE so the whole palette stays covered if it grows.
 *
 * The DOM half proves `buildCaret` actually applies the computed color and
 * moves the identity hue onto the `--cursor-color` custom property (the
 * caret border + label background now come from editor.css). Pure function +
 * one DOM render — no EditorConnection, so nothing to close.
 */
import { describe, it, expect } from "vitest";
import { PALETTE, labelColorFor, buildCaret } from "../cursors";

const DARK_TEXT = "#111827";
const WHITE = "#fff";

// The light hues — white text is unreadable on these, expect dark text.
const LIGHT_HUES = ["#bcf60c", "#fabebe", "#46f0f0"];
// Dark hues that must keep white text (superset of the ticket's minimum).
const DARK_HUES = ["#911eb4", "#800000", "#008080", "#4363d8", "#e6194b"];

describe("labelColorFor", () => {
  it("returns dark text on the light palette hues", () => {
    for (const hue of LIGHT_HUES) {
      expect(labelColorFor(hue)).toBe(DARK_TEXT);
    }
  });

  it("returns white on the dark palette hues", () => {
    for (const hue of DARK_HUES) {
      expect(labelColorFor(hue)).toBe(WHITE);
    }
  });

  it("classifies every one of the 12 palette hues as fff or dark text", () => {
    // Full coverage: whatever the classification, it must be one of the two
    // known-readable values (no undefined / stray hex leaking through).
    for (const hue of PALETTE) {
      expect([DARK_TEXT, WHITE]).toContain(labelColorFor(hue));
    }
  });

  it("only the three light hues get dark text; the rest stay white", () => {
    const dark = PALETTE.filter((h) => labelColorFor(h) === DARK_TEXT);
    expect(dark.sort()).toEqual([...LIGHT_HUES].sort());
  });
});

describe("buildCaret", () => {
  it("puts the identity hue on --cursor-color, not an inline border/bg", () => {
    const caret = buildCaret("#4363d8", "Ada");
    expect(caret.classList.contains("remote-caret")).toBe(true);
    expect(caret.style.getPropertyValue("--cursor-color")).toBe("#4363d8");
    // Border + label background moved to editor.css — not set inline.
    expect(caret.style.borderLeft).toBe("");

    const label = caret.querySelector(".remote-caret-label") as HTMLElement;
    expect(label).not.toBeNull();
    expect(label.textContent).toBe("Ada");
    expect(label.style.background).toBe("");
  });

  it("sets the label text color from labelColorFor (dark hue -> white)", () => {
    const caret = buildCaret("#911eb4", "Grace");
    const label = caret.querySelector(".remote-caret-label") as HTMLElement;
    // jsdom normalizes "#fff" to rgb(); compare against the same source.
    expect(label.style.color).toBe(hexToInline(labelColorFor("#911eb4")));
  });

  it("sets the label text color from labelColorFor (light hue -> dark)", () => {
    const caret = buildCaret("#bcf60c", "Lin");
    const label = caret.querySelector(".remote-caret-label") as HTMLElement;
    expect(label.style.color).toBe(hexToInline(labelColorFor("#bcf60c")));
  });
});

// Round-trip a hex through an element so the assertion matches however jsdom
// serializes the color it stored (it may keep hex or normalize to rgb()).
function hexToInline(hex: string): string {
  const el = document.createElement("span");
  el.style.color = hex;
  return el.style.color;
}
