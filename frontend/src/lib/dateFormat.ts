// Deterministic label render for a `date` atom — the twin of
// `format_date_label` in datasette_paper/markdown.py. This is the canonical,
// serialize-stable label: it ALWAYS includes the year and shows a timed atom's
// wall clock in its *stored* zone (no viewer-zone conversion — `attrs.time` is
// already the author's wall time). The chip NodeView (dateView.ts) has its own
// compact, viewer-facing render (omit current year, convert to the viewer's
// zone); this module is only the schema toDOM fallback + the markdown twin.
// Keep byte-identical with the Python helper (shared test fixtures).
// @feat date: deterministic label render (twin of markdown.py format_date_label)

export interface DateAttrs {
  date: string;
  time: string | null;
  tz: string | null;
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

export function formatDateLabel(attrs: DateAttrs): string {
  const [year, month, day] = (attrs.date || "").split("-");
  let label = `${MONTHS[parseInt(month, 10) - 1]} ${parseInt(day, 10)}, ${parseInt(year, 10)}`;
  if (attrs.time) {
    // `mm` stays the raw 2-char string (matches the Python twin byte-for-byte).
    const [hh, mm] = attrs.time.split(":");
    const hour = parseInt(hh, 10);
    const h12 = hour % 12 || 12;
    const ampm = hour < 12 ? "AM" : "PM";
    label += ` ${h12}:${mm} ${ampm}`;
  }
  return label;
}
