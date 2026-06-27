/**
 * Tests for formatValue + encode/decodeFormat. Output is asserted against the
 * fixed "en-US" locale and UTC dates that formatValue pins, so these are
 * environment-independent. encode/decode round-trip is the gate that keeps the
 * JS and Python (markdown.py / markdown_parser.py) format grammars honest.
 */
import { describe, it, expect } from "vitest";
import {
  formatValue,
  encodeFormat,
  decodeFormat,
  type ValueFormat,
} from "../formatValue";

describe("formatValue", () => {
  it("null format: raw stringify of the cell", () => {
    expect(formatValue(1284902, null)).toBe("1284902");
    expect(formatValue("hello", null)).toBe("hello");
    expect(formatValue(true, null)).toBe("true");
  });

  it("text: explicit raw stringify", () => {
    expect(formatValue(42, { kind: "text" })).toBe("42");
  });

  it("number: grouping by default, decimals when given", () => {
    expect(formatValue(1234567, { kind: "number" })).toBe("1,234,567");
    expect(formatValue(1234.5, { kind: "number", decimals: 0 })).toBe("1,235");
    expect(formatValue(1234.5, { kind: "number", decimals: 2 })).toBe("1,234.50");
  });

  it("number: thousands:false disables grouping", () => {
    expect(formatValue(1234567, { kind: "number", thousands: false })).toBe("1234567");
  });

  it("number: numeric strings parse", () => {
    expect(formatValue("1234.5", { kind: "number", decimals: 1 })).toBe("1,234.5");
  });

  it("number: non-numeric → fallback", () => {
    expect(formatValue("abc", { kind: "number" })).toBe("—");
    expect(formatValue("abc", { kind: "number", fallback: "n/a" })).toBe("n/a");
  });

  it("currency: USD default, ISO override", () => {
    expect(formatValue(1284.5, { kind: "currency" })).toBe("$1,284.50");
    expect(formatValue(1284.5, { kind: "currency", currency: "EUR" })).toBe("€1,284.50");
  });

  it("percent: 0.123 → percent with decimals", () => {
    expect(formatValue(0.123, { kind: "percent", decimals: 1 })).toBe("12.3%");
    expect(formatValue(0.5, { kind: "percent" })).toBe("50%");
  });

  it("date: iso / medium / long, timezone-stable", () => {
    expect(formatValue("2024-01-15", { kind: "date", style: "iso" })).toBe("2024-01-15");
    expect(formatValue("2024-01-15", { kind: "date", style: "medium" })).toBe("Jan 15, 2024");
    expect(formatValue("2024-01-15", { kind: "date", style: "long" })).toBe(
      "January 15, 2024",
    );
    // default style is medium
    expect(formatValue("2024-01-15", { kind: "date" })).toBe("Jan 15, 2024");
  });

  it("date: numeric epoch (seconds) parses", () => {
    // 2021-01-01T00:00:00Z = 1609459200 seconds
    expect(formatValue(1609459200, { kind: "date", style: "iso" })).toBe("2021-01-01");
  });

  it("date: unparseable → fallback", () => {
    expect(formatValue("not a date", { kind: "date" })).toBe("—");
    expect(formatValue("not a date", { kind: "date", fallback: "?" })).toBe("?");
  });

  it("null / empty cell → fallback (default dash, override honored)", () => {
    expect(formatValue(null, { kind: "number" })).toBe("—");
    expect(formatValue("", { kind: "currency" })).toBe("—");
    expect(formatValue(undefined, null)).toBe("—");
    expect(formatValue(null, { kind: "number", fallback: "none" })).toBe("none");
  });

  it("binary object → [binary] under raw/text", () => {
    expect(formatValue({ $base64: true, encoded: "x" }, null)).toBe("[binary]");
  });
});

describe("encodeFormat / decodeFormat", () => {
  const cases: { format: ValueFormat; md: string }[] = [
    { format: null, md: "" },
    { format: { kind: "number" }, md: "number" },
    { format: { kind: "number", decimals: 0 }, md: "number:0" },
    { format: { kind: "number", decimals: 2 }, md: "number:2" },
    { format: { kind: "currency" }, md: "currency" },
    { format: { kind: "currency", currency: "USD" }, md: "currency:USD" },
    { format: { kind: "currency", currency: "EUR" }, md: "currency:EUR" },
    { format: { kind: "percent" }, md: "percent" },
    { format: { kind: "percent", decimals: 1 }, md: "percent:1" },
    { format: { kind: "date" }, md: "date" },
    { format: { kind: "date", style: "medium" }, md: "date:medium" },
    { format: { kind: "date", style: "iso" }, md: "date:iso" },
    { format: { kind: "text" }, md: "text" },
  ];

  for (const { format, md } of cases) {
    it(`encodes ${JSON.stringify(format)} → "${md}"`, () => {
      expect(encodeFormat(format)).toBe(md);
    });
    it(`round-trips ${JSON.stringify(format)}`, () => {
      expect(decodeFormat(encodeFormat(format))).toEqual(format);
    });
  }

  it("decodes unknown/malformed → null", () => {
    expect(decodeFormat("bogus")).toBeNull();
    expect(decodeFormat("number:abc")).toBeNull();
    expect(decodeFormat("date:weekday")).toBeNull();
    expect(decodeFormat("   ")).toBeNull();
  });
});
