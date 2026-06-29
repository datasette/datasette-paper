/**
 * Tests for the table-of-contents helpers: heading extraction, the
 * change-detection signature, defensive config parsing, and level filtering.
 * Pure functions — no EditorView needed.
 */
import { describe, it, expect } from "vitest";
import { schema } from "../schema";
import {
  extractHeadings,
  headingSignature,
  readTocConfig,
  tocEntries,
} from "../tocView";
import { buildSlashCommands } from "../slashMenu";

function heading(level: number, text: string) {
  return schema.node("heading", { level }, [schema.text(text)]);
}
function para(text = "body") {
  return schema.node("paragraph", null, [schema.text(text)]);
}
function doc(...blocks: import("prosemirror-model").Node[]) {
  return schema.node("doc", null, blocks);
}

describe("extractHeadings", () => {
  it("returns {text, level, pos} for top-level headings in document order", () => {
    const d = doc(heading(1, "Intro"), para(), heading(2, "Details"), heading(3, "Deep"));
    const got = extractHeadings(d);
    expect(got.map((h) => [h.level, h.text])).toEqual([
      [1, "Intro"],
      [2, "Details"],
      [3, "Deep"],
    ]);
    // positions are top-level offsets, strictly increasing
    expect(got[0].pos).toBeLessThan(got[1].pos);
    expect(got[1].pos).toBeLessThan(got[2].pos);
  });

  it("ignores non-heading blocks", () => {
    const d = doc(para(), para(), heading(1, "Only"));
    expect(extractHeadings(d).map((h) => h.text)).toEqual(["Only"]);
  });

  it("returns an empty list when there are no headings", () => {
    expect(extractHeadings(doc(para(), para()))).toEqual([]);
  });
});

describe("headingSignature", () => {
  it("changes when a heading's text changes", () => {
    const a = headingSignature(doc(heading(1, "A")));
    const b = headingSignature(doc(heading(1, "B")));
    expect(a).not.toBe(b);
  });

  it("changes when a heading's level changes", () => {
    const a = headingSignature(doc(heading(1, "A")));
    const b = headingSignature(doc(heading(2, "A")));
    expect(a).not.toBe(b);
  });

  it("is stable when only a non-heading paragraph changes", () => {
    const a = headingSignature(doc(heading(1, "A"), para("first")));
    const b = headingSignature(doc(heading(1, "A"), para("second")));
    expect(a).toBe(b);
  });
});

describe("readTocConfig", () => {
  it("defaults to {minLevel:1, maxLevel:3, ordered:true}", () => {
    expect(readTocConfig(undefined)).toEqual({ minLevel: 1, maxLevel: 3, ordered: true });
    expect(readTocConfig({})).toEqual({ minLevel: 1, maxLevel: 3, ordered: true });
  });

  it("clamps maxLevel up to minLevel and both into 1..6", () => {
    expect(readTocConfig({ minLevel: 4, maxLevel: 2 })).toEqual({
      minLevel: 4,
      maxLevel: 4,
      ordered: true,
    });
    expect(readTocConfig({ minLevel: 0, maxLevel: 99 })).toEqual({
      minLevel: 1,
      maxLevel: 6,
      ordered: true,
    });
  });

  it("coerces non-number levels to defaults", () => {
    expect(readTocConfig({ minLevel: "2", maxLevel: null })).toEqual({
      minLevel: 1,
      maxLevel: 3,
      ordered: true,
    });
  });

  it("treats ordered:false as false, absent/other as true", () => {
    expect(readTocConfig({ ordered: false }).ordered).toBe(false);
    expect(readTocConfig({ ordered: true }).ordered).toBe(true);
    expect(readTocConfig({}).ordered).toBe(true);
  });
});

describe("tocEntries (level filtering)", () => {
  it("keeps only headings within [minLevel, maxLevel]", () => {
    const d = doc(heading(1, "H1"), heading(2, "H2"), heading(3, "H3"));
    const got = tocEntries(d, { minLevel: 2, maxLevel: 2, ordered: true });
    expect(got.map((h) => h.text)).toEqual(["H2"]);
  });
});

describe("slash command registry", () => {
  it("includes the table-of-contents command", () => {
    const cmd = buildSlashCommands().find((c) => c.id === "toc");
    expect(cmd).toBeTruthy();
    expect(cmd!.label).toBe("Table of contents");
    expect(cmd!.keywords).toContain("contents");
  });
});
