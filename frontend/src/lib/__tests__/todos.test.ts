/**
 * @feat task-assign: unit tests for the shared TODO helpers — the due-chip
 * label + overdue/today tint, the section breadcrumb, and the client-side
 * due-date bucketing (all in the viewer's local zone). A fixed `now` keeps the
 * boundary cases deterministic.
 */
import { describe, it, expect } from "vitest";

import { bucketTodos, dueChip, sectionBreadcrumb } from "../todos";
import type { TodoRow } from "../todos";

// A fixed local-noon "now" so date-only comparisons are unambiguous.
const NOW = new Date(2026, 6, 14, 12, 0, 0); // 2026-07-14, local

function row(extra: Partial<TodoRow>): TodoRow {
  return {
    doc_id: 1,
    doc_name: "Doc",
    doc_url: "/-/paper/doc/1",
    ordinal: 0,
    text: "task",
    checked: false,
    section: [],
    assignees: ["pat"],
    assignee_inherited: false,
    due: null,
    due_inherited: false,
    ...extra,
  };
}

describe("dueChip", () => {
  it("is null with no due date", () => {
    expect(dueChip(null, NOW)).toBeNull();
  });

  it("tints a past date overdue and a future date neutral", () => {
    expect(dueChip({ date: "2020-01-01", time: null, tz: null }, NOW)!.tint).toBe(
      "overdue",
    );
    expect(dueChip({ date: "2030-01-01", time: null, tz: null }, NOW)!.tint).toBeNull();
  });

  it("tints the viewer's current calendar day 'today'", () => {
    expect(dueChip({ date: "2026-07-14", time: null, tz: null }, NOW)!.tint).toBe(
      "today",
    );
  });

  it("renders a label via the shared date formatter", () => {
    // Exact year suffix depends on the real clock's current year (the shared
    // formatter omits it only for "this year"); assert the stable month/day.
    expect(dueChip({ date: "2026-07-20", time: null, tz: null }, NOW)!.label).toContain(
      "Jul 20",
    );
  });
});

describe("sectionBreadcrumb", () => {
  it("joins heading texts with a chevron", () => {
    expect(
      sectionBreadcrumb([
        { level: 2, text: "Sprint 12" },
        { level: 3, text: "Backend" },
      ]),
    ).toBe("Sprint 12 › Backend");
  });

  it("is empty before any heading", () => {
    expect(sectionBreadcrumb([])).toBe("");
  });
});

describe("bucketTodos", () => {
  it("splits into overdue / today / week / later / none in viewer tz", () => {
    const rows = [
      row({ text: "past", due: { date: "2026-07-01", time: null, tz: null } }),
      row({ text: "today", due: { date: "2026-07-14", time: null, tz: null } }),
      row({ text: "in3", due: { date: "2026-07-17", time: null, tz: null } }),
      row({ text: "in10", due: { date: "2026-07-24", time: null, tz: null } }),
      row({ text: "undated", due: null }),
    ];
    const buckets = bucketTodos(rows, NOW);
    expect(buckets.map((b) => b.key)).toEqual([
      "overdue",
      "today",
      "week",
      "later",
      "none",
    ]);
    expect(buckets.map((b) => b.rows[0].text)).toEqual([
      "past",
      "today",
      "in3",
      "in10",
      "undated",
    ]);
  });

  it("treats exactly today+7 as 'this week' and today+8 as 'later'", () => {
    const rows = [
      row({ text: "edge7", due: { date: "2026-07-21", time: null, tz: null } }),
      row({ text: "edge8", due: { date: "2026-07-22", time: null, tz: null } }),
    ];
    const buckets = bucketTodos(rows, NOW);
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b.rows]));
    expect(byKey.week.map((r) => r.text)).toEqual(["edge7"]);
    expect(byKey.later.map((r) => r.text)).toEqual(["edge8"]);
  });

  it("omits empty buckets entirely", () => {
    const buckets = bucketTodos(
      [row({ due: { date: "2020-01-01", time: null, tz: null } })],
      NOW,
    );
    expect(buckets.map((b) => b.key)).toEqual(["overdue"]);
  });

  it("sinks done tasks after open ones within a bucket, stably", () => {
    const rows = [
      row({ text: "open-a", checked: false, due: { date: "2026-07-01", time: null, tz: null } }),
      row({ text: "done-a", checked: true, due: { date: "2026-07-01", time: null, tz: null } }),
      row({ text: "open-b", checked: false, due: { date: "2026-07-02", time: null, tz: null } }),
    ];
    const [overdue] = bucketTodos(rows, NOW);
    expect(overdue.rows.map((r) => r.text)).toEqual(["open-a", "open-b", "done-a"]);
  });
});
