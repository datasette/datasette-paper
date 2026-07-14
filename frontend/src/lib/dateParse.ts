/**
 * A hand-rolled, dependency-free natural-language date mini-parser for the
 * date-node insert popup. `parseDateInput` turns a short English phrase
 * (`tomorrow`, `jul 20`, `next fri 3pm`, `7/20/2026`, `15:00`) into a
 * `{ date, time }` pair — `date` an ISO `YYYY-MM-DD`, `time` a 24-hour
 * `HH:MM` or `null` when the input carried no time.
 *
 * The function is pure: it NEVER reads the wall clock. Every relative form
 * ("today", "next friday", a yearless month rollover) is resolved against
 * the caller-supplied `now` using its *local* components
 * (`getFullYear` / `getMonth` / `getDate` / `getDay`), so a test can pin the
 * clock to a fixture and callers pass the real `new Date()`. Time-zone
 * stamping is not this module's concern — the popup records the browser zone
 * separately.
 *
 * The grammar is deliberately strict: anything that doesn't match a known
 * form (or matches ambiguously, like a slash date with month > 12) returns
 * `null` rather than guessing.
 */

// @feat date: natural-language date/time mini-parser (grammar → {date, time})

/** Result of a successful parse: an ISO date plus an optional 24h time. */
export interface ParsedDate {
  date: string;
  time: string | null;
}

const MONTHS = new Map<string, number>([
  ["january", 1],
  ["jan", 1],
  ["february", 2],
  ["feb", 2],
  ["march", 3],
  ["mar", 3],
  ["april", 4],
  ["apr", 4],
  ["may", 5],
  ["june", 6],
  ["jun", 6],
  ["july", 7],
  ["jul", 7],
  ["august", 8],
  ["aug", 8],
  ["september", 9],
  ["sep", 9],
  ["october", 10],
  ["oct", 10],
  ["november", 11],
  ["nov", 11],
  ["december", 12],
  ["dec", 12],
]);

const WEEKDAYS = new Map<string, number>([
  ["sunday", 0],
  ["sun", 0],
  ["monday", 1],
  ["mon", 1],
  ["tuesday", 2],
  ["tue", 2],
  ["wednesday", 3],
  ["wed", 3],
  ["thursday", 4],
  ["thu", 4],
  ["friday", 5],
  ["fri", 5],
  ["saturday", 6],
  ["sat", 6],
]);

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Format explicit Y/M/D components as `YYYY-MM-DD` (year zero-padded to 4). */
function fmt(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

/**
 * True when `year`-`month`-`day` (month 1-12) is a real calendar date.
 * Rejects the roll-over impostors (`feb 30`, `2026-02-30`) by round-tripping
 * through a Date and checking every component survived unchanged. The Date is
 * built from explicit components only — it never reads the clock.
 */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(year, month - 1, day);
  return dt.getFullYear() === year && dt.getMonth() === month - 1 && dt.getDate() === day;
}

/**
 * The ISO date `offset` days from `now`'s local date. Uses a component-built
 * Date purely to normalize month/day overflow (e.g. `+10` days crossing a
 * month boundary) — no clock read.
 */
function offsetDays(now: Date, offset: number): string {
  const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return fmt(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

/**
 * Days from `now` to the next occurrence of weekday `target` (0 = Sunday),
 * counting STRICTLY after today: when today already is `target` the answer is
 * 7, never 0. `next <weekday>` adds a further 7 on top of this.
 */
function weekdayDelta(now: Date, target: number): number {
  const delta = (target - now.getDay() + 7) % 7;
  return delta === 0 ? 7 : delta;
}

/**
 * Resolve a yearless month/day to its next occurrence on or after `now`'s
 * date: build it in `now`'s year and, if that lands strictly before today
 * (date-only, ignoring time), roll to the next year. Returns `null` when the
 * day is not a real calendar date in the resolved year.
 */
function resolveYearless(month: number, day: number, now: Date): string | null {
  const year = now.getFullYear();
  if (!isRealDate(year, month, day)) return null;
  const candidate = new Date(year, month - 1, day).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (candidate < today) {
    return isRealDate(year + 1, month, day) ? fmt(year + 1, month, day) : null;
  }
  return fmt(year, month, day);
}

/** Two-digit years map to 20xx; anything longer is taken verbatim. */
function normalizeYear(raw: string): number {
  const n = Number(raw);
  return raw.length <= 2 ? 2000 + n : n;
}

/**
 * Parse a bare time token to `HH:MM`, or `null` if it isn't a valid time.
 *
 * Two forms: `3pm` / `3:30pm` / `3:30 pm` / `9am` (12-hour, minute optional,
 * an optional space before am/pm; `12am` = 00:00, `12pm` = 12:00) and
 * `15:00` / `9:00` (24-hour, which REQUIRES the `H:MM` minutes). Rejects
 * out-of-range values loudly (`13pm`, `25:00`, `3:60`).
 */
function parseTime(token: string): string | null {
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(token);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = ampm[2] ? Number(ampm[2]) : 0;
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (ampm[3] === "am") {
      if (hour === 12) hour = 0;
    } else if (hour !== 12) {
      hour += 12;
    }
    return `${pad2(hour)}:${pad2(minute)}`;
  }
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (h24) {
    const hour = Number(h24[1]);
    const minute = Number(h24[2]);
    if (hour > 23 || minute > 59) return null;
    return `${pad2(hour)}:${pad2(minute)}`;
  }
  return null;
}

/**
 * Split a trailing time token off the input. Returns the date portion (empty
 * string when the whole input was a bare time) and the parsed `HH:MM`, or
 * `null` when a time-shaped tail is present but invalid (so the whole input
 * is rejected). No trailing time → `{ datePart: input, time: null }`. No date
 * form has a colon or an am/pm suffix, so this never mis-splits a date.
 */
function splitTime(input: string): { datePart: string; time: string | null } | null {
  const m = /^(?:(.*\S)\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})$/.exec(input);
  if (!m) return { datePart: input, time: null };
  const time = parseTime(m[2]);
  if (time === null) return null;
  return { datePart: m[1] ?? "", time };
}

/** Parse `mon day [year]` / `day mon [year]` (full name or 3-letter abbrev). */
function parseMonthName(datePart: string, now: Date): string | null {
  const tokens = datePart.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 3) return null;

  let monthPos = -1;
  let month = 0;
  for (let i = 0; i < tokens.length; i++) {
    const m = MONTHS.get(tokens[i]);
    if (m !== undefined) {
      if (monthPos !== -1) return null; // two month tokens — ambiguous
      monthPos = i;
      month = m;
    }
  }
  // The month must lead (`mon day [year]`) or sit second (`day mon [year]`);
  // the year, when present, is always last.
  let dayTok: string;
  let yearTok: string | undefined;
  if (monthPos === 0) {
    dayTok = tokens[1];
    yearTok = tokens[2];
  } else if (monthPos === 1) {
    dayTok = tokens[0];
    yearTok = tokens[2];
  } else {
    return null;
  }
  if (!/^\d{1,2}$/.test(dayTok)) return null;
  const day = Number(dayTok);

  if (tokens.length === 3) {
    if (yearTok === undefined || !/^\d{1,4}$/.test(yearTok)) return null;
    const year = normalizeYear(yearTok);
    return isRealDate(year, month, day) ? fmt(year, month, day) : null;
  }
  return resolveYearless(month, day, now);
}

/** Parse the date portion (time already stripped) to an ISO date or `null`. */
function parseDatePart(part: string, now: Date): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(part);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return isRealDate(year, month, day) ? fmt(year, month, day) : null;
  }

  const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{1,4}))?$/.exec(part);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    if (month < 1 || month > 12) return null; // US month-first; no fallback guessing
    if (slash[3] !== undefined) {
      const year = normalizeYear(slash[3]);
      return isRealDate(year, month, day) ? fmt(year, month, day) : null;
    }
    return resolveYearless(month, day, now);
  }

  if (part === "today") return offsetDays(now, 0);
  if (part === "tomorrow") return offsetDays(now, 1);
  if (part === "yesterday") return offsetDays(now, -1);

  const next = /^next\s+([a-z]+)$/.exec(part);
  if (next) {
    const wd = WEEKDAYS.get(next[1]);
    return wd === undefined ? null : offsetDays(now, weekdayDelta(now, wd) + 7);
  }

  if (/^[a-z]+$/.test(part)) {
    const wd = WEEKDAYS.get(part);
    return wd === undefined ? null : offsetDays(now, weekdayDelta(now, wd));
  }

  return parseMonthName(part, now);
}

/**
 * Parse a natural-language date phrase into `{ date, time }`, resolving every
 * relative form against `now`'s local date. Returns `null` for empty input or
 * anything outside the grammar. See the module docstring for the full form
 * list; `dateParse.test.ts` is the exhaustive spec.
 */
export function parseDateInput(input: string, now: Date): ParsedDate | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;

  const split = splitTime(trimmed);
  if (split === null) return null;

  const { datePart, time } = split;
  const date =
    datePart === ""
      ? fmt(now.getFullYear(), now.getMonth() + 1, now.getDate())
      : parseDatePart(datePart, now);
  if (date === null) return null;

  return { date, time };
}
