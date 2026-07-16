/**
 * dateView: the compact chip label + the overdue/today decoration predicate.
 * Both are pure (given `now`) so they're tested without an EditorView. The
 * decoration test builds small docs from the real schema and asserts which
 * date atoms get which tint class — the regression the plugin exists for is
 * that a *checked* task's date goes neutral even though the checkbox toggle
 * never fires the date NodeView's update.
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import {
  DateView,
  chipLabel,
  classifyDate,
  dateDecorationSpecs,
  insertRelativeDateCommand,
  resolveInstant,
} from "../dateView";
import type { DateAttrs } from "../dateFormat";

function isoOffset(days: number): string {
  const n = new Date();
  const t = new Date(n.getFullYear(), n.getMonth(), n.getDate() + days);
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${t.getFullYear()}-${m}-${d}`;
}

function firstDate(doc: PMNode): PMNode | null {
  let found: PMNode | null = null;
  doc.descendants((n) => {
    if (!found && n.type.name === "date") found = n;
    return !found;
  });
  return found;
}

// A fixed "now": Tuesday 2026-07-14 10:00 local.
const NOW = new Date(2026, 6, 14, 10, 0, 0);

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS_ABBR = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** `instant` re-expressed as a timed atom authored in UTC — lets a test pin an
 *  exact instant without depending on the host zone. */
function utcAttrs(instant: Date): DateAttrs {
  const date = `${instant.getUTCFullYear()}-${pad2(instant.getUTCMonth() + 1)}-${pad2(instant.getUTCDate())}`;
  return { date, time: `${pad2(instant.getUTCHours())}:${pad2(instant.getUTCMinutes())}`, tz: "UTC" };
}

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
    // The chip renders the whole authored instant (date AND time) in the
    // viewer's zone; the tooltip carries the authored wall date/time + zone.
    const attrs: DateAttrs = { date: "2026-07-20", time: "09:00", tz: "Asia/Tokyo" };
    // vitest runs in the host zone, so assert the invariant instead — a
    // tooltip appears iff the stored zone differs from the viewer's.
    const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { title } = chipLabel(attrs, NOW);
    if (viewerZone === "Asia/Tokyo") expect(title).toBeNull();
    else expect(title).toContain("author's time");
  });

  it("derives the displayed calendar day from the instant in the viewer's zone", () => {
    // 4:00 PM PDT on Jul 25 = 2026-07-25T23:00Z — already Jul 26 for any
    // viewer east of UTC-1ish. The displayed day must be the instant's local
    // day, not the authored `attrs.date` (the pre-fix render read a day "off"
    // whenever the conversion crossed midnight).
    const attrs: DateAttrs = { date: "2026-07-25", time: "16:00", tz: "America/Los_Angeles" };
    const instant = resolveInstant(attrs)!;
    expect(instant.toISOString()).toBe("2026-07-25T23:00:00.000Z");
    const localDay = `${MONTHS_ABBR[instant.getMonth()]} ${instant.getDate()}`;
    const { text } = chipLabel(attrs, NOW);
    expect(text.startsWith(`${localDay},`)).toBe(true);
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
    // NOW − 2h: same viewer-local day, but the instant has passed.
    const attrs = utcAttrs(new Date(NOW.getTime() - 2 * 60 * 60 * 1000));
    expect(classifyDate(attrs, NOW)).toBe("overdue");
  });
  it("leaves a future instant on a later viewer-local day neutral", () => {
    // NOW + 26h lands on the viewer's tomorrow (10:00 → 12:00 next day).
    const attrs = utcAttrs(new Date(NOW.getTime() + 26 * 60 * 60 * 1000));
    expect(classifyDate(attrs, NOW)).toBeNull();
  });
  it("classifies a timed atom by its instant, not the authored date string", () => {
    // NOW + 2h authored in UTC+14 (Kiritimati): the author's wall date can sit
    // a day AHEAD of the viewer's today, and vice versa a zone behind can sit
    // a day BEHIND. Either way the instant is 2h away on the viewer's current
    // day → "today", never "overdue"/null (the pre-fix string comparison
    // against the viewer's today misclassified both directions).
    const instant = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    for (const tz of ["Pacific/Kiritimati", "Etc/GMT+12"]) {
      const dtf = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const p: Record<string, string> = {};
      for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
      const attrs: DateAttrs = {
        date: `${p.year}-${p.month}-${p.day}`,
        time: `${p.hour}:${p.minute}`,
        tz,
      };
      expect(resolveInstant(attrs)!.getTime()).toBe(instant.getTime());
      expect(classifyDate(attrs, NOW)).toBe("today");
    }
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

describe("insertRelativeDateCommand", () => {
  it("Mod-; inserts today's date-only chip at the cursor", () => {
    const state = EditorState.create({
      doc: schema.nodes.doc.create(null, [schema.nodes.paragraph.create()]),
      schema,
    });
    let next = state;
    const handled = insertRelativeDateCommand(0)(state, (tr) => {
      next = state.apply(tr);
    });
    expect(handled).toBe(true);
    const date = firstDate(next.doc)!;
    expect(date.attrs).toEqual({
      date: isoOffset(0),
      time: null,
      tz: null,
      format: null,
    });
  });

  it("Mod-Shift-; inserts tomorrow's date", () => {
    const state = EditorState.create({
      doc: schema.nodes.doc.create(null, [schema.nodes.paragraph.create()]),
      schema,
    });
    let next = state;
    insertRelativeDateCommand(1)(state, (tr) => {
      next = state.apply(tr);
    });
    expect(firstDate(next.doc)!.attrs.date).toBe(isoOffset(1));
  });

  it("falls through (returns false) inside a code block", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.code_block.create(null, schema.text("select 1")),
    ]);
    let state = EditorState.create({ doc, schema });
    state = state.apply(
      state.tr.setSelection(TextSelection.create(doc, 3)), // inside the code
    );
    const handled = insertRelativeDateCommand(0)(state, () => {
      throw new Error("should not dispatch");
    });
    expect(handled).toBe(false);
  });
});

// ── Popup editor (mounted NodeView) ────────────────────────────────────────

const mounted: EditorView[] = [];
afterEach(() => {
  for (const v of mounted.splice(0)) v.destroy();
});

function mountDate(attrs: DateAttrs) {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, [dateAtom(attrs)]),
  ]);
  const place = document.createElement("div");
  place.className = "editor-host";
  document.body.appendChild(place);
  let editable = true;
  const view = new EditorView(place, {
    state: EditorState.create({ doc }),
    editable: () => editable,
    nodeViews: {
      date: (node, v, getPos) =>
        new DateView(node, v, getPos as () => number | undefined),
    },
  });
  mounted.push(view);
  const chip = place.querySelector(".pm-date") as HTMLElement;
  const setEditable = (next: boolean) => {
    editable = next;
    view.setProps({ editable: () => editable });
  };
  return { view, chip, setEditable };
}

function typeAndEnter(chip: HTMLElement, text: string) {
  const input = chip.querySelector(".pm-date-popup-input") as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
}

describe("DateView popup", () => {
  it("opens on click in edit mode and commits a date-only parse (no tz)", () => {
    const { view, chip } = mountDate({ date: "2026-07-20", time: null, tz: null });
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(chip.querySelector(".pm-date-popup")).not.toBeNull();

    typeAndEnter(chip, "2026-08-01");
    const date = view.state.doc.firstChild!.firstChild!;
    expect(date.attrs.date).toBe("2026-08-01");
    expect(date.attrs.time).toBeNull();
    expect(date.attrs.tz).toBeNull();
    // popup closed after commit
    expect(document.querySelector(".pm-date-popup")).toBeNull();
  });

  it("stamps the browser tz only when the parse has a time", () => {
    const { view, chip } = mountDate({ date: "2026-07-20", time: null, tz: null });
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    typeAndEnter(chip, "2026-08-01 3:30pm");
    const date = view.state.doc.firstChild!.firstChild!;
    expect(date.attrs.time).toBe("15:30");
    expect(date.attrs.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("prefills a timed atom in the viewer's zone; an untouched Enter keeps the instant", () => {
    // Authored 4:00 PM PDT. The popup must prefill the equivalent viewer-local
    // wall time — commit() stamps the VIEWER's zone, so prefilling the
    // author's literal "16:00" would silently shift the event by the zone
    // difference for any collaborator who re-commits (e.g. only to switch the
    // display format).
    const attrs: DateAttrs = { date: "2026-07-25", time: "16:00", tz: "America/Los_Angeles" };
    const before = resolveInstant(attrs)!.getTime();
    const { view, chip } = mountDate(attrs);
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const input = chip.querySelector(".pm-date-popup-input") as HTMLInputElement;
    const local = new Date(before);
    const ymd = `${local.getFullYear()}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`;
    expect(input.value).toBe(`${ymd} ${pad2(local.getHours())}:${pad2(local.getMinutes())}`);

    // Enter without editing anything.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const date = view.state.doc.firstChild!.firstChild!;
    expect(date.attrs.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(resolveInstant(date.attrs as DateAttrs)!.getTime()).toBe(before);
  });

  it("does not commit or close on an unrecognized parse", () => {
    const { view, chip } = mountDate({ date: "2026-07-20", time: null, tz: null });
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    typeAndEnter(chip, "sometime soon");
    // unchanged + still open
    expect(view.state.doc.firstChild!.firstChild!.attrs.date).toBe("2026-07-20");
    expect(chip.querySelector(".pm-date-popup")).not.toBeNull();
    const preview = chip.querySelector(".pm-date-popup-preview");
    expect(preview?.textContent).toBe("unrecognized");
  });

  it("is inert in read-only mode (no popup on click)", () => {
    const { chip, setEditable } = mountDate({ date: "2026-07-20", time: null, tz: null });
    setEditable(false);
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(chip.querySelector(".pm-date-popup")).toBeNull();
  });

  it("Escape closes the popup without committing", () => {
    const { view, chip } = mountDate({ date: "2026-07-20", time: null, tz: null });
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = chip.querySelector(".pm-date-popup-input") as HTMLInputElement;
    input.value = "2026-09-09";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(chip.querySelector(".pm-date-popup")).toBeNull();
    expect(view.state.doc.firstChild!.firstChild!.attrs.date).toBe("2026-07-20");
  });

  it("picking a format preset commits it as the node's format attr", () => {
    const { view, chip } = mountDate({ date: "2026-07-20", time: null, tz: null });
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // The ISO preset row shows a description + its own rendered example.
    const isoRow = chip.querySelector<HTMLElement>('.pm-date-format[data-format="%Y-%m-%d"]')!;
    expect(isoRow.querySelector(".pm-date-format-desc")?.textContent).toBe("ISO");
    expect(isoRow.querySelector(".pm-date-format-example")?.textContent).toBe("2026-07-20");
    const radio = isoRow.querySelector<HTMLInputElement>(".pm-date-format-radio")!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    expect(chip.querySelector(".pm-date-popup-preview")?.textContent).toBe(
      "→ 2026-07-20",
    );
    // Enter commits the date + the selected format together.
    typeAndEnter(chip, "2026-07-20");
    expect(view.state.doc.firstChild!.firstChild!.attrs.format).toBe("%Y-%m-%d");
  });

  it("a custom strftime string commits verbatim", () => {
    const { view, chip } = mountDate({ date: "2026-07-20", time: null, tz: null });
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const custom = chip.querySelector(".pm-date-popup-custom") as HTMLInputElement;
    custom.value = "%A the %o";
    custom.dispatchEvent(new Event("input", { bubbles: true }));
    expect(chip.querySelector(".pm-date-popup-preview")?.textContent).toBe(
      "→ Monday the 20th",
    );
    typeAndEnter(chip, "2026-07-20");
    expect(view.state.doc.firstChild!.firstChild!.attrs.format).toBe("%A the %o");
  });
});
