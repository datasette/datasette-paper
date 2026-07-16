// Deterministic label render for a `date` atom — the twin of
// `format_date_label` in datasette_paper/date_atom.py. This is the canonical,
// serialize-stable label: absent a custom `format` it shows "Jul 20, 2026"
// (year always) and shows a timed atom's wall clock in its *stored* zone (no
// viewer-zone conversion — `attrs.time` is already the author's wall time). A
// custom `format` (a strftime pattern) styles the DATE portion; the time still
// auto-appends. The chip NodeView (dateView.ts) has its own compact,
// viewer-facing render (omit current year, convert to the viewer's zone).
// Keep `strftimeDate` byte-identical with the Python twin (shared fixtures).
// @feat date: deterministic label render (twin of date_atom.py format_date_label)

export interface DateAttrs {
  date: string;
  time: string | null;
  tz: string | null;
  /** A strftime pattern styling the date portion, or null/undefined = default. */
  format?: string | null;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTHS_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
// Indexed by Monday=0 (matches datetime.date.weekday() on the Python side).
const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const WEEKDAYS_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function ordinal(d: number): string {
  const mod100 = d % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${d}th`;
  switch (d % 10) {
    case 1:
      return `${d}st`;
    case 2:
      return `${d}nd`;
    case 3:
      return `${d}rd`;
    default:
      return `${d}th`;
  }
}

/** Monday=0 weekday for a proleptic Gregorian date.
 *
 * Avoids `new Date(y, ...)`, whose legacy constructor silently remaps years
 * 0-99 to 1900-1999. Temporal.PlainDate would express this directly, but
 * Temporal is not yet available in Safari without a polyfill.
 */
function gregorianWeekday(y: number, m: number, d: number): number {
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let year = y;
  if (m < 3) year -= 1;
  const sundayZero =
    (year + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400) +
      offsets[m - 1] +
      d) %
    7;
  return (sundayZero + 6) % 7;
}

/**
 * Render a calendar date through a small, fixed strftime subset — the twin of
 * `strftime_date` in date_atom.py. Hardcoded English names and a fixed directive
 * set (NOT the platform/locale strftime) so both sides agree byte-for-byte.
 * Directives (a leading `-` drops zero-pad): %Y %y %m %-m %B %b %d %-d %o %A %a
 * %%. `%o` is a paper extension — the ordinal day (20th). Unknown directives
 * pass through literally.
 */
export function strftimeDate(fmt: string, y: number, m: number, d: number): string {
  const weekday = gregorianWeekday(y, m, d);
  let out = "";
  let i = 0;
  const n = fmt.length;
  while (i < n) {
    const ch = fmt[i];
    if (ch !== "%") {
      out += ch;
      i++;
      continue;
    }
    i++;
    if (i >= n) {
      out += "%";
      break;
    }
    let dash = false;
    if (fmt[i] === "-") {
      dash = true;
      i++;
      if (i >= n) {
        out += "%-";
        break;
      }
    }
    const spec = fmt[i];
    i++;
    switch (spec) {
      case "Y":
        out += String(y);
        break;
      case "y":
        out += pad2(y % 100);
        break;
      case "m":
        out += dash ? String(m) : pad2(m);
        break;
      case "B":
        out += MONTHS_FULL[m - 1];
        break;
      case "b":
        out += MONTHS[m - 1];
        break;
      case "d":
        out += dash ? String(d) : pad2(d);
        break;
      case "o":
        out += ordinal(d);
        break;
      case "A":
        out += WEEKDAYS[weekday];
        break;
      case "a":
        out += WEEKDAYS_ABBR[weekday];
        break;
      case "%":
        out += "%";
        break;
      default:
        out += (dash ? "%-" : "%") + spec; // unknown → literal
    }
  }
  return out;
}

/** The 12-hour "3:00 PM" auto-appended after a timed atom's date portion. */
export function formatDateTime(time: string): string {
  const [hh, mm] = time.split(":");
  const hour = Number(hh);
  const h12 = hour % 12 || 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${mm} ${ampm}`;
}

export function formatDateLabel(attrs: DateAttrs): string {
  const [year, month, day] = attrs.date.split("-").map(Number);
  let label = attrs.format
    ? strftimeDate(attrs.format, year, month, day)
    : `${MONTHS[month - 1]} ${day}, ${year}`;
  if (attrs.time) label += ` ${formatDateTime(attrs.time)}`;
  return label;
}

// --- zone-aware instant + overdue/today classification ----------------------
// Pure date math (Intl only, no ProseMirror), kept here in the PM-free date
// module so the inline chip (dateView.ts) AND the read-only TODO surfaces
// (todos.ts) can share one overdue/today rule without either dragging the
// NodeView + PM into its bundle. @feat date: instant/tint math.

/** The offset (minutes, local − UTC) of `tz` at instant `at`. Throws on an
 *  unresolvable zone name (the caller degrades to naive rendering). */
function tzOffsetMinutes(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUTC - at.getTime()) / 60000;
}

/** Resolve a timed atom's UTC instant from its authored wall time + zone, or
 *  null when it has no time or the zone can't be resolved (naive rendering). */
export function resolveInstant(attrs: DateAttrs): Date | null {
  if (!attrs.time || !attrs.tz) return null;
  const [y, mo, d] = attrs.date.split("-").map(Number);
  const [hh, mm] = attrs.time.split(":").map(Number);
  const wallUTC = Date.UTC(y, mo - 1, d, hh, mm);
  try {
    // Two passes so a DST boundary (offset differs side-to-side) converges.
    let off = tzOffsetMinutes(attrs.tz, new Date(wallUTC));
    let inst = new Date(wallUTC - off * 60000);
    off = tzOffsetMinutes(attrs.tz, inst);
    inst = new Date(wallUTC - off * 60000);
    return inst;
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD` for `d` in the viewer's local zone. */
export function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The tint class for a date atom evaluated against `now`, or null (neutral).
 *  Overdue = the instant/day has passed; today = it is the viewer's current
 *  calendar day and not yet passed. Timed atoms classify purely by instant —
 *  passed → overdue, else by the instant's calendar day in the VIEWER's zone
 *  (comparing the authored `attrs.date` string here marks a future instant
 *  overdue for any viewer whose local date is already past the author's).
 *  Date-only (and timed-without-zone) atoms compare by calendar day. */
export function classifyDate(
  attrs: DateAttrs,
  now: Date,
): "overdue" | "today" | null {
  const todayStr = localYmd(now);
  const instant = resolveInstant(attrs);
  if (instant) {
    if (instant.getTime() < now.getTime()) return "overdue";
    return localYmd(instant) === todayStr ? "today" : null;
  }
  if (attrs.date < todayStr) return "overdue";
  if (attrs.date === todayStr) return "today";
  return null;
}
