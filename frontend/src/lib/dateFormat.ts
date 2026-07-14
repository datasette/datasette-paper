// Deterministic label render for a `date` atom — the twin of
// `format_date_label` in datasette_paper/markdown.py. This is the canonical,
// serialize-stable label: absent a custom `format` it shows "Jul 20, 2026"
// (year always) and shows a timed atom's wall clock in its *stored* zone (no
// viewer-zone conversion — `attrs.time` is already the author's wall time). A
// custom `format` (a strftime pattern) styles the DATE portion; the time still
// auto-appends. The chip NodeView (dateView.ts) has its own compact,
// viewer-facing render (omit current year, convert to the viewer's zone).
// Keep `strftimeDate` byte-identical with the Python twin (shared fixtures).
// @feat date: deterministic label render (twin of markdown.py format_date_label)

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

/**
 * Render a calendar date through a small, fixed strftime subset — the twin of
 * `strftime_date` in markdown.py. Hardcoded English names and a fixed directive
 * set (NOT the platform/locale strftime) so both sides agree byte-for-byte.
 * Directives (a leading `-` drops zero-pad): %Y %y %m %-m %B %b %d %-d %o %A %a
 * %%. `%o` is a paper extension — the ordinal day (20th). Unknown directives
 * pass through literally.
 */
export function strftimeDate(fmt: string, y: number, m: number, d: number): string {
  const weekday = (new Date(y, m - 1, d).getDay() + 6) % 7; // Monday=0
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
