/**
 * Filter/sort config helpers for table-mode `block_embed`s: the Datasette
 * operator registry (its `Filters.lookups()` transcribed — same keys, same
 * display labels, same no-argument flags), defensive sanitizers for the
 * `config.filters` / `config.sort` bags, and the config → query-param
 * translation shared by the `.json` fetch URL and the header title link.
 *
 * `op` is the Datasette query-string suffix verbatim (`exact`, `contains`,
 * `isnull`, …) so translation is mechanical; `value` is always a string —
 * Datasette does its own numeric casting and `in`-list parsing server-side.
 * Config can arrive from hand-written markdown via the append API, so every
 * reader here degrades per-entry and never throws.
 */

export interface EmbedFilter {
  column: string;
  op: string;
  value?: string;
}

export interface EmbedSort {
  column: string;
  desc?: boolean;
}

/**
 * Datasette's filter operators, in its own menu order. `key` is the query
 * suffix (`column__<key>=…`), `label` the display string, `noValue` marks
 * the no-argument ops (which send "1" as the value on the wire).
 */
export const FILTER_OPS: { key: string; label: string; noValue?: boolean }[] = [
  { key: "exact", label: "=" },
  { key: "not", label: "!=" },
  { key: "contains", label: "contains" },
  { key: "notcontains", label: "does not contain" },
  { key: "endswith", label: "ends with" },
  { key: "startswith", label: "starts with" },
  { key: "gt", label: ">" },
  { key: "gte", label: "≥" },
  { key: "lt", label: "<" },
  { key: "lte", label: "≤" },
  { key: "like", label: "like" },
  { key: "notlike", label: "not like" },
  { key: "glob", label: "glob" },
  { key: "in", label: "in" },
  { key: "notin", label: "not in" },
  { key: "arraycontains", label: "array contains" },
  { key: "arraynotcontains", label: "array does not contain" },
  { key: "date", label: "date" },
  { key: "isnull", label: "is null", noValue: true },
  { key: "notnull", label: "is not null", noValue: true },
  { key: "isblank", label: "is blank", noValue: true },
  { key: "notblank", label: "is not blank", noValue: true },
];

const OPS_BY_KEY = new Map(FILTER_OPS.map((op) => [op.key, op]));

/**
 * The valid filters from a raw `config.filters` value. Non-array → `[]`.
 * An entry that isn't an object, lacks a non-empty string `column`, names an
 * `op` outside the registry, or (for a value-taking op) has no string
 * `value` is skipped — per entry, never the whole list, never throwing
 * (the `selectedColumns()` spirit: bad config degrades, it doesn't poison).
 */
export function sanitizeFilters(raw: unknown): EmbedFilter[] {
  if (!Array.isArray(raw)) return [];
  const out: EmbedFilter[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { column, op, value } = entry as {
      column?: unknown;
      op?: unknown;
      value?: unknown;
    };
    if (typeof column !== "string" || column.length === 0) continue;
    if (typeof op !== "string") continue;
    const known = OPS_BY_KEY.get(op);
    if (!known) continue;
    if (known.noValue) {
      out.push({ column, op });
    } else if (typeof value === "string") {
      out.push({ column, op, value });
    }
  }
  return out;
}

/**
 * The valid sort from a raw `config.sort` value, or `null` when absent or
 * malformed (no non-empty string `column`). `desc` is coerced to a strict
 * boolean so a truthy-junk value can't sneak through.
 */
export function sanitizeSort(raw: unknown): EmbedSort | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { column, desc } = raw as { column?: unknown; desc?: unknown };
  if (typeof column !== "string" || column.length === 0) return null;
  return { column, desc: desc === true };
}

/**
 * Translate sanitized filters + sort into Datasette query-param pairs —
 * shared by the `.json` fetch URL and the header title link (both feed the
 * pairs through `URLSearchParams`, which owns the encoding).
 *
 * Always the explicit `column__op` suffix, never bare `column=value`, so
 * `_`-prefixed and `__`-containing column names can't collide with
 * Datasette's special params (the trick its own facet code uses). No-value
 * ops send `"1"` (what Datasette's cog menu emits). Sort emits `_sort` xor
 * `_sort_desc`, never both. Unknown ops are dropped here too, belt and
 * braces — Datasette 400s on unknown suffixes against real columns.
 */
export function filterQueryParams(
  filters: EmbedFilter[],
  sort: EmbedSort | null,
): [string, string][] {
  const pairs: [string, string][] = [];
  for (const f of filters) {
    const known = OPS_BY_KEY.get(f.op);
    if (!known) continue;
    pairs.push([`${f.column}__${f.op}`, known.noValue ? "1" : (f.value ?? "")]);
  }
  if (sort) pairs.push([sort.desc ? "_sort_desc" : "_sort", sort.column]);
  return pairs;
}
