/**
 * The grammar spec for the natural-language date mini-parser. Table-driven
 * over a FIXED `now` = 2026-07-14T10:00:00 local (a Tuesday), so every
 * relative form has a deterministic expected value. Downstream tickets should
 * treat this file as the contract for what `parseDateInput` accepts.
 */
import { describe, it, expect } from "vitest";

import { parseDateInput } from "../dateParse";

// 2026-07-14 is a Tuesday (getDay() === 2). Month is 0-indexed in the Date
// constructor, so 6 = July. All fixtures below are relative to this instant.
const NOW = new Date(2026, 6, 14, 10, 0, 0);

// @feat date: exhaustive grammar spec — every form, rollover boundary, and reject
describe("parseDateInput fixture sanity", () => {
  it("pins NOW to a Tuesday so the weekday cases are meaningful", () => {
    expect(NOW.getDay()).toBe(2);
    expect(NOW.getFullYear()).toBe(2026);
    expect(NOW.getMonth()).toBe(6);
    expect(NOW.getDate()).toBe(14);
  });
});

type Case = [input: string, date: string, time: string | null];

const VALID: Case[] = [
  // ISO — as written, real-calendar-validated
  ["2026-07-20", "2026-07-20", null],
  ["2024-02-29", "2024-02-29", null], // real leap day
  ["2026-01-01", "2026-01-01", null],

  // slash, US month-first
  ["7/20/2026", "2026-07-20", null],
  ["7/20/26", "2026-07-20", null], // 2-digit year → 20xx
  ["12/25/2026", "2026-12-25", null],
  ["01/05/2027", "2027-01-05", null],

  // slash, yearless → next occurrence (same rollover as month-name)
  ["7/20", "2026-07-20", null], // still upcoming this year
  ["7/14", "2026-07-14", null], // today counts (on or after)
  ["7/13", "2027-07-13", null], // already past → next year
  ["1/5", "2027-01-05", null], // Jan is past in July → next year
  ["12/25", "2026-12-25", null], // Dec still upcoming this year

  // month name — both orders, full + 3-letter abbrev
  ["jul 20", "2026-07-20", null],
  ["july 20", "2026-07-20", null],
  ["20 jul", "2026-07-20", null],
  ["20 july", "2026-07-20", null],
  ["july 20 2026", "2026-07-20", null],
  ["20 july 2026", "2026-07-20", null],
  ["jul 20 26", "2026-07-20", null], // 2-digit year in the yeared form too
  ["may 1", "2027-05-01", null], // May is past → next year (name == abbrev)

  // month-name yearless rollover boundary
  ["jul 14", "2026-07-14", null], // today → on-or-after keeps this year
  ["jul 13", "2027-07-13", null], // one day past → next year
  ["jan 5", "2027-01-05", null], // typed in July → next January
  ["dec 25", "2026-12-25", null], // typed in July → this year's Dec 25
  ["feb 29", "2028-02-29", null], // next real occurrence skips non-leap years

  // relative
  ["today", "2026-07-14", null],
  ["tomorrow", "2026-07-15", null],
  ["yesterday", "2026-07-13", null],
  ["TODAY", "2026-07-14", null], // case-insensitive
  ["  tomorrow  ", "2026-07-15", null], // trimmed

  // weekday — next occurrence STRICTLY AFTER today
  ["wednesday", "2026-07-15", null], // +1
  ["wed", "2026-07-15", null],
  ["thursday", "2026-07-16", null], // +2
  ["friday", "2026-07-17", null], // +3
  ["fri", "2026-07-17", null],
  ["saturday", "2026-07-18", null], // +4
  ["sunday", "2026-07-19", null], // +5
  ["monday", "2026-07-20", null], // +6
  ["tuesday", "2026-07-21", null], // typed ON Tuesday → +7, never today

  // next weekday — one week past the plain-weekday result.
  // Rule: delta = weekdayDelta(now, wd) (which is 7 when today IS wd) + 7.
  ["next friday", "2026-07-24", null], // plain fri (+3) + 7
  ["next fri", "2026-07-24", null],
  ["next tuesday", "2026-07-28", null], // typed on Tue: plain (+7) + 7 = +14
  ["next wednesday", "2026-07-22", null], // plain wed (+1) + 7

  // time alone → today's date + time
  ["3pm", "2026-07-14", "15:00"],
  ["3:30pm", "2026-07-14", "15:30"],
  ["3:30 pm", "2026-07-14", "15:30"], // space before am/pm
  ["15:00", "2026-07-14", "15:00"],
  ["9am", "2026-07-14", "09:00"],
  ["9:00am", "2026-07-14", "09:00"],
  ["12am", "2026-07-14", "00:00"], // midnight
  ["12pm", "2026-07-14", "12:00"], // noon
  ["12:00am", "2026-07-14", "00:00"],
  ["12:00pm", "2026-07-14", "12:00"],
  ["0:00", "2026-07-14", "00:00"],
  ["23:59", "2026-07-14", "23:59"],
  ["9:05am", "2026-07-14", "09:05"], // single-digit hour, padded

  // time suffix appended to ANY date form
  ["jul 20 3pm", "2026-07-20", "15:00"],
  ["july 20 2026 3:30pm", "2026-07-20", "15:30"],
  ["fri 15:00", "2026-07-17", "15:00"],
  ["7/20 3:30pm", "2026-07-20", "15:30"],
  ["today 9am", "2026-07-14", "09:00"],
  ["tomorrow 12pm", "2026-07-15", "12:00"],
  ["next fri 9:00am", "2026-07-24", "09:00"],
  ["2026-07-20 15:30", "2026-07-20", "15:30"],
  ["jul 20 3:30 pm", "2026-07-20", "15:30"], // internal space in time
];

describe("parseDateInput — valid forms", () => {
  it.each(VALID)("%j → %s %s", (input, date, time) => {
    expect(parseDateInput(input, NOW)).toEqual({ date, time });
  });
});

const REJECT: string[] = [
  "13/1", // month > 12, no fallback guessing to "Jan 13"
  "0/5", // month 0
  "13/1/2026", // month > 12 even with a year
  "feb 30", // not a real February date
  "2026-02-30", // ISO impostor
  "2026-13-01", // ISO month out of range
  "2025-02-29", // 2025 is not a leap year
  "2/30", // slash impostor
  "25:00", // hour out of range
  "24:00", // 24h has no hour 24
  "13pm", // 12-hour form only goes to 12
  "0pm", // 12-hour hour must be 1-12
  "3:60", // minute out of range
  "3:60pm", // minute out of range with am/pm too
  "15", // bare number is not a time (needs H:MM) and not a date
  "sometime soon", // gibberish phrase
  "", // empty
  "   ", // whitespace only
  "jan", // month name alone — no day
  "july", // full month alone
  "32", // bare number
  "jul 32", // day out of range for the month
  "jul", // (abbrev alone)
  "next", // dangling next
  "next january", // next + non-weekday
  "next 5", // next + non-weekday
  "20 20", // two numbers, no month
  "jul jul 20", // two month tokens — ambiguous
  "asdf", // gibberish
  "friday funday", // weekday + junk
];

describe("parseDateInput — rejects (loud null, never a guess)", () => {
  it.each(REJECT)("%j → null", (input) => {
    expect(parseDateInput(input, NOW)).toBeNull();
  });
});

describe("parseDateInput — determinism", () => {
  it("resolves relative forms only from `now`, not the wall clock", () => {
    const other = new Date(2030, 0, 1, 0, 0, 0); // 2030-01-01
    expect(parseDateInput("today", other)).toEqual({ date: "2030-01-01", time: null });
    // `jan 1` on 2030-01-01 → today counts (on or after) → same year
    expect(parseDateInput("jan 1", other)).toEqual({ date: "2030-01-01", time: null });
    // A yearless date one day past rolls forward relative to THIS now
    expect(parseDateInput("dec 31", other)).toEqual({ date: "2030-12-31", time: null });
  });
});
