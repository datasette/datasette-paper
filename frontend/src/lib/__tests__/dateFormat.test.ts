/**
 * The `date` atom's canonical label render. The fixture table below is shared
 * byte-for-byte with the Python twin in tests/test_date_atom.py
 * (`DATE_LABEL_FIXTURES` / `test_format_date_label_matches_fixtures`); keep the
 * two in sync whenever either label renderer changes — the markdown round-trip
 * relies on both sides producing an identical label.
 */
import { describe, it, expect } from "vitest";

import { formatDateLabel, strftimeDate, type DateAttrs } from "../dateFormat";

// strftimeDate fixtures — mirrored byte-for-byte with STRFTIME_FIXTURES in
// tests/test_date_atom.py. 2026-07-20 is a Monday.
const STRFTIME_FIXTURES: [string, number, number, number, string][] = [
  ["%Y-%m-%d", 2026, 7, 20, "2026-07-20"],
  ["%b %-d, %Y", 2026, 7, 20, "Jul 20, 2026"],
  ["%B %-d, %Y", 2026, 7, 5, "July 5, 2026"],
  ["%A, %B %o", 2026, 7, 20, "Monday, July 20th"],
  ["%a %b %-d", 2026, 7, 20, "Mon Jul 20"],
  ["%m/%d/%y", 2026, 7, 5, "07/05/26"],
  ["%A %a", 1, 1, 1, "Monday Mon"],
  ["%A %a", 99, 12, 31, "Thursday Thu"],
  ["%o", 2026, 7, 1, "1st"],
  ["%o", 2026, 7, 2, "2nd"],
  ["%o", 2026, 7, 3, "3rd"],
  ["%o", 2026, 7, 11, "11th"],
  ["%o", 2026, 7, 21, "21st"],
  ["100%% sure on the %-d", 2026, 7, 4, "100% sure on the 4"],
  ["%Q", 2026, 7, 4, "%Q"], // unknown directive passes through literally
];

describe("strftimeDate", () => {
  for (const [fmt, y, m, d, expected] of STRFTIME_FIXTURES) {
    it(`"${fmt}" on ${y}-${m}-${d} → "${expected}"`, () => {
      expect(strftimeDate(fmt, y, m, d)).toBe(expected);
    });
  }
});

describe("formatDateLabel with a custom format", () => {
  it("styles the date and auto-appends the time", () => {
    expect(
      formatDateLabel({
        date: "2026-07-20",
        time: "15:00",
        tz: "UTC",
        format: "%A, %B %o",
      }),
    ).toBe("Monday, July 20th 3:00 PM");
  });
});

// (attrs, expected label) — mirrored in tests/test_markdown.py
const FIXTURES: [DateAttrs, string][] = [
  [{ date: "2026-07-20", time: null, tz: null }, "Jul 20, 2026"],
  [{ date: "2026-01-05", time: null, tz: null }, "Jan 5, 2026"],
  [{ date: "2026-12-25", time: null, tz: null }, "Dec 25, 2026"],
  [{ date: "1999-11-02", time: null, tz: null }, "Nov 2, 1999"],
  [{ date: "2026-07-20", time: "15:00", tz: "America/Los_Angeles" }, "Jul 20, 2026 3:00 PM"],
  [{ date: "2026-07-20", time: "00:00", tz: "UTC" }, "Jul 20, 2026 12:00 AM"],
  [{ date: "2026-07-20", time: "12:00", tz: "UTC" }, "Jul 20, 2026 12:00 PM"],
  [{ date: "2026-07-20", time: "09:05", tz: "Europe/London" }, "Jul 20, 2026 9:05 AM"],
  [{ date: "2026-07-20", time: "23:30", tz: "Asia/Tokyo" }, "Jul 20, 2026 11:30 PM"],
];

// @feat date: label helper matches the Python twin on shared fixtures
describe("formatDateLabel", () => {
  for (const [attrs, expected] of FIXTURES) {
    it(`renders ${JSON.stringify(attrs)} as "${expected}"`, () => {
      expect(formatDateLabel(attrs)).toBe(expected);
    });
  }

  it("always includes the year (serialize is not clock-dependent)", () => {
    // Even a current-year date keeps its year here — the chip's "omit current
    // year" nicety is a client-only render, never the canonical label.
    expect(formatDateLabel({ date: "2026-07-20", time: null, tz: null })).toContain(
      "2026",
    );
  });
});
