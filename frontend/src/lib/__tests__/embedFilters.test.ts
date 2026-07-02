/**
 * Tests for the block_embed filter/sort config helpers: the Datasette
 * operator registry, the defensive config sanitizers, and the config →
 * query-param translation shared by the fetch URL and the title link.
 */
import { describe, it, expect } from "vitest";

import {
  FILTER_OPS,
  configFromUrlParams,
  filterOpByKey,
  filterQueryParams,
  sanitizeFilters,
  sanitizeSort,
} from "../embedFilters";
import { TOOLBAR_ICONS } from "../icons";

describe("FILTER_OPS", () => {
  it("carries all 22 Datasette operators with unique keys", () => {
    expect(FILTER_OPS).toHaveLength(22);
    expect(new Set(FILTER_OPS.map((o) => o.key)).size).toBe(22);
  });

  it("flags exactly the four no-argument ops as noValue", () => {
    const noValue = FILTER_OPS.filter((o) => o.noValue).map((o) => o.key);
    expect(noValue.sort()).toEqual(["isblank", "isnull", "notblank", "notnull"]);
  });

  it("labels every op for the picker UI", () => {
    for (const op of FILTER_OPS) {
      expect(op.label.length).toBeGreaterThan(0);
    }
  });
});

describe("filterOpByKey", () => {
  it("looks up registry entries by key, undefined for unknown keys", () => {
    expect(filterOpByKey("exact")).toEqual({ key: "exact", label: "=" });
    expect(filterOpByKey("isnull")?.noValue).toBe(true);
    expect(filterOpByKey("regex")).toBeUndefined();
  });
});

describe("filter panel + column menu icons", () => {
  it("registers the people / funnel / funnelFill / x icon slots", () => {
    for (const name of ["people", "funnel", "funnelFill", "x"]) {
      expect(TOOLBAR_ICONS[name], name).toContain("<path");
    }
  });

  it("registers the column-menu slots: sortUp / sortDown / eyeSlash / chevronDown / eye", () => {
    for (const name of ["sortUp", "sortDown", "eyeSlash", "chevronDown", "eye"]) {
      expect(TOOLBAR_ICONS[name], name).toContain("<path");
    }
  });
});

describe("sanitizeFilters", () => {
  it("returns [] for a non-array (missing, object, string)", () => {
    expect(sanitizeFilters(undefined)).toEqual([]);
    expect(sanitizeFilters(null)).toEqual([]);
    expect(sanitizeFilters("nope")).toEqual([]);
    expect(sanitizeFilters({ column: "a", op: "exact", value: "x" })).toEqual([]);
  });

  it("keeps valid entries and drops bad ones, per entry", () => {
    const out = sanitizeFilters([
      { column: "state", op: "exact", value: "CA" }, // good
      { op: "exact", value: "CA" }, // missing column
      { column: "", op: "exact", value: "CA" }, // empty column
      { column: "state", op: "regex", value: "x" }, // unknown op
      { column: "population", op: "gt" }, // value-taking op, missing value
      { column: "population", op: "gt", value: 10000 }, // non-string value
      "junk", // not an object
      null,
      { column: "notes", op: "notblank" }, // good — no-value op needs no value
    ]);
    expect(out).toEqual([
      { column: "state", op: "exact", value: "CA" },
      { column: "notes", op: "notblank" },
    ]);
  });

  it("keeps an empty-string value (a legal Datasette filter argument)", () => {
    expect(sanitizeFilters([{ column: "notes", op: "exact", value: "" }])).toEqual([
      { column: "notes", op: "exact", value: "" },
    ]);
  });

  it("drops a stray value on a no-value op rather than sending it", () => {
    expect(sanitizeFilters([{ column: "notes", op: "isnull", value: "junk" }])).toEqual([
      { column: "notes", op: "isnull" },
    ]);
  });
});

describe("sanitizeSort", () => {
  it("returns null for missing/malformed sort", () => {
    expect(sanitizeSort(undefined)).toBeNull();
    expect(sanitizeSort(null)).toBeNull();
    expect(sanitizeSort("population")).toBeNull();
    expect(sanitizeSort([])).toBeNull();
    expect(sanitizeSort({})).toBeNull();
    expect(sanitizeSort({ column: 3, desc: true })).toBeNull();
    expect(sanitizeSort({ column: "", desc: true })).toBeNull();
  });

  it("keeps a valid sort and coerces desc to a strict boolean", () => {
    expect(sanitizeSort({ column: "population", desc: true })).toEqual({
      column: "population",
      desc: true,
    });
    expect(sanitizeSort({ column: "population" })).toEqual({
      column: "population",
      desc: false,
    });
    expect(sanitizeSort({ column: "population", desc: "yes" })).toEqual({
      column: "population",
      desc: false,
    });
  });
});

describe("filterQueryParams", () => {
  it("always emits the explicit column__op suffix, never bare column=value", () => {
    expect(filterQueryParams([{ column: "state", op: "exact", value: "CA" }], null)).toEqual([
      ["state__exact", "CA"],
    ]);
  });

  it("keeps __-containing and _-prefixed column names unambiguous", () => {
    expect(
      filterQueryParams([{ column: "a__weird_col", op: "gt", value: "3" }], null),
    ).toEqual([["a__weird_col__gt", "3"]]);
    expect(filterQueryParams([{ column: "_size", op: "exact", value: "x" }], null)).toEqual([
      ["_size__exact", "x"],
    ]);
  });

  it("emits value '1' for no-value ops", () => {
    expect(filterQueryParams([{ column: "notes", op: "notblank" }], null)).toEqual([
      ["notes__notblank", "1"],
    ]);
  });

  it("keeps multiple filters, in order, including repeats on one column", () => {
    expect(
      filterQueryParams(
        [
          { column: "age", op: "gte", value: "2" },
          { column: "age", op: "lte", value: "9" },
        ],
        null,
      ),
    ).toEqual([
      ["age__gte", "2"],
      ["age__lte", "9"],
    ]);
  });

  it("drops entries with unknown ops (belt and braces after sanitize)", () => {
    expect(filterQueryParams([{ column: "a", op: "regex", value: "x" }], null)).toEqual([]);
  });

  it("emits exactly one of _sort / _sort_desc", () => {
    const asc = filterQueryParams([], { column: "name" });
    expect(asc).toEqual([["_sort", "name"]]);
    const desc = filterQueryParams([], { column: "name", desc: true });
    expect(desc).toEqual([["_sort_desc", "name"]]);
    expect(filterQueryParams([], null)).toEqual([]);
  });
});

describe("configFromUrlParams", () => {
  const parse = (query: string) => configFromUrlParams(new URLSearchParams(query));

  it("returns {} for an empty query", () => {
    expect(parse("")).toEqual({});
  });

  it("treats a bare col=value as an exact filter", () => {
    expect(parse("state=CA")).toEqual({
      filters: [{ column: "state", op: "exact", value: "CA" }],
    });
  });

  it("maps a known __ suffix to its op", () => {
    expect(parse("state__contains=CA")).toEqual({
      filters: [{ column: "state", op: "contains", value: "CA" }],
    });
  });

  it("splits on the last __, so a known suffix wins over a __-containing column", () => {
    expect(parse("state__exact=CA")).toEqual({
      filters: [{ column: "state", op: "exact", value: "CA" }],
    });
    expect(parse("a__weird_col__gt=3")).toEqual({
      filters: [{ column: "a__weird_col", op: "gt", value: "3" }],
    });
  });

  it("drops the wire dummy value on a no-value op", () => {
    expect(parse("notes__notblank=1")).toEqual({
      filters: [{ column: "notes", op: "notblank" }],
    });
  });

  it("keeps the whole key as an exact-filter column when the suffix is unknown", () => {
    expect(parse("weird__foo=x")).toEqual({
      filters: [{ column: "weird__foo", op: "exact", value: "x" }],
    });
  });

  it("keeps repeated params, in URL order", () => {
    expect(parse("age__gte=2&age__lte=9")).toEqual({
      filters: [
        { column: "age", op: "gte", value: "2" },
        { column: "age", op: "lte", value: "9" },
      ],
    });
  });

  it("treats a _-prefixed key with an explicit suffix as a filter (Datasette's rule)", () => {
    expect(parse("_size__exact=x")).toEqual({
      filters: [{ column: "_size", op: "exact", value: "x" }],
    });
  });

  it("skips empty column names", () => {
    expect(parse("=x&__gt=5")).toEqual({});
  });

  it("parses _sort and _sort_desc", () => {
    expect(parse("_sort=name")).toEqual({ sort: { column: "name" } });
    expect(parse("_sort_desc=population")).toEqual({
      sort: { column: "population", desc: true },
    });
  });

  it("emits no sort when both _sort and _sort_desc are present (Datasette 400s it)", () => {
    expect(parse("_sort=a&_sort_desc=b")).toEqual({});
  });

  it("collects _col in order, deduped, dropping empties", () => {
    expect(parse("_col=name&_col=state&_col=name&_col=")).toEqual({
      columns: ["name", "state"],
    });
  });

  it("ignores out-of-vocabulary specials", () => {
    expect(parse("_search=x&_size=10&_facet=state&_where=1=1&_next=tok&_nocol=id")).toEqual(
      {},
    );
  });

  it("round-trips filterQueryParams output", () => {
    const filters = [
      { column: "state", op: "contains", value: "CA" },
      { column: "notes", op: "isnull" },
      { column: "a__weird_col", op: "gt", value: "3" },
    ];
    const sort = { column: "population", desc: true };
    const params = new URLSearchParams(filterQueryParams(filters, sort));
    expect(configFromUrlParams(params)).toEqual({ filters, sort });
  });
});
