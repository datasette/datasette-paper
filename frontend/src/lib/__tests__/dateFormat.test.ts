/**
 * The `date` atom's canonical label render. The fixture table below is shared
 * byte-for-byte with the Python twin in tests/test_markdown.py
 * (`DATE_LABEL_FIXTURES` / `test_format_date_label_matches_fixtures`); keep the
 * two in sync whenever either label renderer changes — the markdown round-trip
 * relies on both sides producing an identical label.
 */
import { describe, it, expect } from "vitest";

import { formatDateLabel, type DateAttrs } from "../dateFormat";

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
