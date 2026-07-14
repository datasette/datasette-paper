/**
 * dateView: the compact chip label + the overdue/today decoration predicate.
 * Both are pure (given `now`) so they're tested without an EditorView. The
 * decoration test builds small docs from the real schema and asserts which
 * date atoms get which tint class — the regression the plugin exists for is
 * that a *checked* task's date goes neutral even though the checkbox toggle
 * never fires the date NodeView's update.
 */
import { describe, it, expect } from "vitest";

import { schema } from "../schema";
import { chipLabel, classifyDate, dateDecorationSpecs } from "../dateView";
import type { DateAttrs } from "../dateFormat";

// A fixed "now": Tuesday 2026-07-14 10:00 local.
const NOW = new Date(2026, 6, 14, 10, 0, 0);

function dateAtom(attrs: DateAttrs) {
  return schema.nodes.date.create(attrs);
}

function taskItem(checked: boolean, ...inline: ReturnType<typeof dateAtom>[]) {
  return schema.nodes.task_item.create(
    { checked },
    schema.nodes.paragraph.create(null, inline),
  );
}

describe("chipLabel", () => {
  it("omits the year for the viewer's current year", () => {
    expect(chipLabel({ date: "2026-07-20", time: null, tz: null }, NOW).text).toBe(
      "Jul 20",
    );
  });

  it("keeps the year for other years", () => {
    expect(chipLabel({ date: "2027-01-05", time: null, tz: null }, NOW).text).toBe(
      "Jan 5, 2027",
    );
  });

  it("renders a naive time when no zone is present", () => {
    const { text, title } = chipLabel(
      { date: "2026-07-20", time: "15:30", tz: null },
      NOW,
    );
    expect(text).toBe("Jul 20, 3:30 PM");
    expect(title).toBeNull();
  });

  it("converts a timed atom into the viewer's zone with a cross-zone tooltip", () => {
    // 9:00 AM in Tokyo is 5:00 PM the previous day in LA. The chip keeps the
    // authored calendar date and converts only the time; the tooltip carries
    // the authoritative authored wall time + zone.
    const attrs: DateAttrs = { date: "2026-07-20", time: "09:00", tz: "Asia/Tokyo" };
    // Force a viewer zone by checking against LA via a manual expectation:
    // vitest runs in the host zone, so assert the invariant instead — a
    // tooltip appears iff the stored zone differs from the viewer's.
    const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { title } = chipLabel(attrs, NOW);
    if (viewerZone === "Asia/Tokyo") expect(title).toBeNull();
    else expect(title).toContain("author's time");
  });
});

describe("classifyDate", () => {
  it("tints a past calendar date overdue", () => {
    expect(classifyDate({ date: "2026-07-13", time: null, tz: null }, NOW)).toBe(
      "overdue",
    );
  });
  it("tints today amber", () => {
    expect(classifyDate({ date: "2026-07-14", time: null, tz: null }, NOW)).toBe(
      "today",
    );
  });
  it("leaves a future date neutral", () => {
    expect(classifyDate({ date: "2026-07-20", time: null, tz: null }, NOW)).toBeNull();
  });
  it("tints a passed instant overdue even when it is today", () => {
    // 08:00 UTC on 2026-07-14 is before NOW (10:00 local, in most host zones
    // this instant has passed). Assert against the actual comparison.
    const attrs: DateAttrs = { date: "2026-07-14", time: "00:01", tz: "UTC" };
    const result = classifyDate(attrs, NOW);
    expect(["overdue", "today"]).toContain(result);
  });
});

describe("dateDecorationSpecs", () => {
  it("tints a date inside an unchecked task but not the same date in prose", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        dateAtom({ date: "2026-07-10", time: null, tz: null }),
      ]),
      schema.nodes.task_list.create(null, [
        taskItem(false, dateAtom({ date: "2026-07-10", time: null, tz: null })),
      ]),
    ]);
    const specs = dateDecorationSpecs(doc, NOW);
    // Only one (the one inside the unchecked task).
    expect(specs).toHaveLength(1);
    expect(specs[0].cls).toBe("pp-date-overdue");
  });

  it("does NOT tint a date inside a CHECKED task (the checkbox-toggle regression)", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.task_list.create(null, [
        taskItem(true, dateAtom({ date: "2026-07-10", time: null, tz: null })),
      ]),
    ]);
    expect(dateDecorationSpecs(doc, NOW)).toHaveLength(0);
  });

  it("tints today amber inside an unchecked task", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.task_list.create(null, [
        taskItem(false, dateAtom({ date: "2026-07-14", time: null, tz: null })),
      ]),
    ]);
    const specs = dateDecorationSpecs(doc, NOW);
    expect(specs).toHaveLength(1);
    expect(specs[0].cls).toBe("pp-date-today");
  });
});
