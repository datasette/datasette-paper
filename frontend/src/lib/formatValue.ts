/**
 * Formatting for inline SQL values (`value` node `format` attr).
 *
 * Quarto punts on inline formatting (it tells you to pre-compute); our values
 * are live, so formatting is a first-class per-instance config. `formatValue`
 * turns a raw cell + a `ValueFormat` into a display string via `Intl.*` (no new
 * deps); `encodeFormat` / `decodeFormat` are its tiny markdown grammar
 * (`| kind:arg`), unit-tested both directions. The Python serializer/parser
 * (`markdown.py` / `markdown_parser.py`) hand-port the same encode/decode rules
 * — keep the three in lock-step.
 *
 * `null` format = raw stringify of the cell. Null/empty cells (and unparseable
 * numbers/dates) render the shared `fallback` (default "—").
 */

export type ValueFormat =
  | null
  | { kind: "number"; decimals?: number; thousands?: boolean; fallback?: string }
  | { kind: "currency"; currency?: string; fallback?: string } // ISO 4217, dflt USD
  | { kind: "percent"; decimals?: number; fallback?: string } // 0.123 -> "12.3%"
  | { kind: "date"; style?: "iso" | "medium" | "long"; fallback?: string }
  | { kind: "text"; fallback?: string };

export type ValueFormatKind = "number" | "currency" | "percent" | "date" | "text";

const DEFAULT_FALLBACK = "—";
// Explicit locale so output is deterministic across environments/tests.
const LOCALE = "en-US";
const DATE_STYLES = new Set(["iso", "medium", "long"]);

function rawString(cell: unknown): string {
  if (typeof cell === "object") return "[binary]"; // {$base64: ...}
  return String(cell);
}

/** Coerce a cell to a finite number, or null when it isn't numeric. */
function toNumber(cell: unknown): number | null {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  if (typeof cell === "string") {
    if (cell.trim() === "") return null;
    const n = Number(cell);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Parse a cell into a Date defensively: ISO-ish strings + numeric epochs
 *  (sub-1e12 numbers are treated as seconds). Unparseable → null. */
function toDate(cell: unknown): Date | null {
  if (typeof cell === "number") {
    const ms = Math.abs(cell) < 1e12 ? cell * 1000 : cell;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof cell === "string") {
    const d = new Date(cell);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function formatValue(cell: unknown, format: ValueFormat): string {
  const fallback = format?.fallback ?? DEFAULT_FALLBACK;
  if (cell === null || cell === undefined || cell === "") return fallback;
  if (format === null) return rawString(cell);

  switch (format.kind) {
    case "text":
      return rawString(cell);
    case "number": {
      const n = toNumber(cell);
      if (n === null) return fallback;
      const opts: Intl.NumberFormatOptions = { useGrouping: format.thousands !== false };
      if (format.decimals != null) {
        opts.minimumFractionDigits = format.decimals;
        opts.maximumFractionDigits = format.decimals;
      }
      return new Intl.NumberFormat(LOCALE, opts).format(n);
    }
    case "currency": {
      const n = toNumber(cell);
      if (n === null) return fallback;
      return new Intl.NumberFormat(LOCALE, {
        style: "currency",
        currency: format.currency ?? "USD",
      }).format(n);
    }
    case "percent": {
      const n = toNumber(cell);
      if (n === null) return fallback;
      const opts: Intl.NumberFormatOptions = { style: "percent" };
      if (format.decimals != null) {
        opts.minimumFractionDigits = format.decimals;
        opts.maximumFractionDigits = format.decimals;
      }
      return new Intl.NumberFormat(LOCALE, opts).format(n);
    }
    case "date": {
      const d = toDate(cell);
      if (d === null) return fallback;
      const style = format.style ?? "medium";
      if (style === "iso") return d.toISOString().slice(0, 10);
      // UTC so the rendered date is stable regardless of the viewer's timezone
      // (and matches the iso branch).
      return new Intl.DateTimeFormat(LOCALE, { dateStyle: style, timeZone: "UTC" }).format(d);
    }
  }
}

/** Encode a `format` into its `| kind:arg` markdown suffix (the part after the
 *  pipe). `null` → "". `fallback` is intentionally not encoded — the markdown
 *  grammar carries only `kind[:arg]`. */
export function encodeFormat(format: ValueFormat): string {
  if (!format) return "";
  switch (format.kind) {
    case "number":
      return format.decimals != null ? `number:${format.decimals}` : "number";
    case "currency":
      return format.currency ? `currency:${format.currency}` : "currency";
    case "percent":
      return format.decimals != null ? `percent:${format.decimals}` : "percent";
    case "date":
      return format.style ? `date:${format.style}` : "date";
    case "text":
      return "text";
  }
}

/** Inverse of `encodeFormat`. Unknown/malformed → null (the caller keeps the
 *  ref, drops the format). */
export function decodeFormat(s: string): ValueFormat {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const idx = trimmed.indexOf(":");
  const kind = (idx < 0 ? trimmed : trimmed.slice(0, idx)).trim();
  const arg = idx < 0 ? "" : trimmed.slice(idx + 1).trim();

  switch (kind) {
    case "number": {
      if (arg === "") return { kind: "number" };
      if (!/^\d+$/.test(arg)) return null;
      return { kind: "number", decimals: Number(arg) };
    }
    case "percent": {
      if (arg === "") return { kind: "percent" };
      if (!/^\d+$/.test(arg)) return null;
      return { kind: "percent", decimals: Number(arg) };
    }
    case "currency":
      return arg ? { kind: "currency", currency: arg } : { kind: "currency" };
    case "date": {
      if (arg === "") return { kind: "date" };
      if (!DATE_STYLES.has(arg)) return null;
      return { kind: "date", style: arg as "iso" | "medium" | "long" };
    }
    case "text":
      return { kind: "text" };
    default:
      return null;
  }
}
