/**
 * NodeView + decoration plugin for the inline `date` atom.
 *
 * The chip (`DateView`) is a synchronous, self-contained render — a date is
 * its own label, so unlike `mention` there is no async resolver. It renders a
 * compact viewer-facing label (leading calendar glyph + text):
 *
 *   date-only   → "Jul 20"          (current year) / "Jul 20, 2026" (other)
 *   timed       → "Jul 20, 3:00 PM" (the time converted to the VIEWER's zone
 *                 when `attrs.tz` differs; a `title` tooltip then shows the
 *                 authored wall time + zone. Unresolvable/absent zone → the
 *                 naive stored wall-clock, no conversion.)
 *
 * NOTE (deliberate, per plans/date-node): only the *time* is zone-converted;
 * the displayed calendar date is always the authored `attrs.date`. For a timed
 * atom near midnight in a distant zone the pair can read a day "off" — the
 * tooltip carries the authoritative authored instant. Revisit if this bites.
 *
 * Overdue/today tinting is NOT the NodeView's job — it lives in
 * `dateDecorationPlugin` (below), because toggling a task checkbox is a
 * `setNodeMarkup` on the *ancestor* `task_item` and never fires this view's
 * `update`, whereas decorations recompute on every transaction.
 */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { NodeView } from "prosemirror-view";
import { TOOLBAR_ICONS } from "./icons";
import { guardChromeMousedown } from "./caretGuard";
import type { DateAttrs } from "./dateFormat";

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

const CAL_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${TOOLBAR_ICONS.calendarEvent}</svg>`;

function attrsOf(node: PMNode): DateAttrs {
  return {
    date: String(node.attrs.date ?? ""),
    time: node.attrs.time ?? null,
    tz: node.attrs.tz ?? null,
  };
}

// --- zone-aware time helpers (pure; jsdom's Intl is enough for tests) -------

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

/** 12-hour "3:00 PM" from a raw 24h `HH:MM` (no zone conversion). */
function naiveTime(time: string): string {
  const [hh, mm] = time.split(":");
  const hour = Number(hh);
  const h12 = hour % 12 || 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${mm} ${ampm}`;
}

function timeInZone(instant: Date, zone: string | undefined, withName = false): string {
  const dtf = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    ...(withName ? { timeZoneName: "short" as const } : {}),
  });
  return dtf.format(instant);
}

/** Compact chip label + optional cross-zone tooltip. `now` supplies the
 *  current year (so the year is omitted only for the viewer's current year). */
export function chipLabel(
  attrs: DateAttrs,
  now: Date,
): { text: string; title: string | null } {
  const [y, mo, d] = attrs.date.split("-").map(Number);
  let dateText = `${MONTHS[mo - 1]} ${d}`;
  if (y !== now.getFullYear()) dateText += `, ${y}`;

  if (!attrs.time) return { text: dateText, title: null };

  const instant = resolveInstant(attrs);
  if (!instant) {
    // No zone / unresolvable → show the naive stored wall clock, no tooltip.
    return { text: `${dateText}, ${naiveTime(attrs.time)}`, title: null };
  }
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const text = `${dateText}, ${timeInZone(instant, viewerZone)}`;
  const title =
    attrs.tz && attrs.tz !== viewerZone
      ? `${timeInZone(instant, attrs.tz, true)} — author's time`
      : null;
  return { text, title };
}

// @feat date: NodeView — compact viewer-facing chip (glyph + zone-aware label)
export class DateView implements NodeView {
  dom: HTMLSpanElement;
  private attrs: DateAttrs;

  constructor(node: PMNode) {
    this.attrs = attrsOf(node);
    this.dom = document.createElement("span");
    this.dom.className = "pm-date";
    // Caret guard: chip chrome is not editable text — a bare click must not
    // drop a caret inside it (see caretGuard.ts / commits a4abcf8, c5d50e2).
    this.dom.style.userSelect = "none";
    guardChromeMousedown(this.dom);
    this.render();
  }

  private render(): void {
    this.dom.setAttribute("data-date", this.attrs.date);
    this.dom.setAttribute("data-date-time", this.attrs.time ?? "");
    this.dom.setAttribute("data-date-tz", this.attrs.tz ?? "");
    const { text, title } = chipLabel(this.attrs, new Date());
    // CAL_ICON is a trusted constant (TOOLBAR_ICONS); the label is set as a
    // text node, never innerHTML.
    this.dom.innerHTML = `<span class="pm-date-icon" aria-hidden="true">${CAL_ICON}</span>`;
    this.dom.appendChild(document.createTextNode(text));
    if (title) this.dom.setAttribute("title", title);
    else this.dom.removeAttribute("title");
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "date") return false;
    const next = attrsOf(node);
    if (
      next.date !== this.attrs.date ||
      next.time !== this.attrs.time ||
      next.tz !== this.attrs.tz
    ) {
      this.attrs = next;
      this.render();
    }
    return true;
  }

  // Leaf atom we fully own — keep PM out of its internals so it selects and
  // deletes as a unit.
  ignoreMutation(): boolean {
    return true;
  }
  stopEvent(): boolean {
    return false;
  }
}

// --- overdue / today decoration plugin --------------------------------------

/** The tint class for a date atom evaluated against `now`, or null (neutral).
 *  Overdue = the instant/day has passed; today = it is the viewer's current
 *  calendar day and not yet passed. Timed atoms compare by instant; date-only
 *  (and timed-without-zone) atoms compare by calendar day. */
export function classifyDate(attrs: DateAttrs, now: Date): "overdue" | "today" | null {
  const todayStr = localYmd(now);
  const instant = resolveInstant(attrs);
  if (instant) {
    if (instant.getTime() < now.getTime()) return "overdue";
    if (attrs.date < todayStr) return "overdue";
    if (attrs.date === todayStr) return "today";
    return null;
  }
  if (attrs.date < todayStr) return "overdue";
  if (attrs.date === todayStr) return "today";
  return null;
}

/** `YYYY-MM-DD` for `d` in the viewer's local zone. */
function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** True iff `pos` (a date atom) sits inside a `task_item`; returns that item's
 *  `checked` flag, or null when there is no enclosing task_item. */
function enclosingTaskChecked(doc: PMNode, pos: number): boolean | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "task_item") return !!node.attrs.checked;
  }
  return null;
}

/** Pure spec builder (testable): the tint decorations for `doc` at `now` —
 *  a date atom is tinted only when its nearest enclosing task_item is
 *  unchecked (past dates in prose stay neutral). */
export function dateDecorationSpecs(
  doc: PMNode,
  now: Date,
): Array<{ from: number; to: number; cls: string }> {
  const specs: Array<{ from: number; to: number; cls: string }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "date") return true;
    if (enclosingTaskChecked(doc, pos) !== false) return true;
    const cls = classifyDate(attrsOf(node), now);
    if (cls) specs.push({ from: pos, to: pos + node.nodeSize, cls: `pp-date-${cls}` });
    return true;
  });
  return specs;
}

function buildDecorations(doc: PMNode): DecorationSet {
  const specs = dateDecorationSpecs(doc, new Date());
  return DecorationSet.create(
    doc,
    specs.map((s) => Decoration.node(s.from, s.to, { class: s.cls })),
  );
}

export const dateDecorationKey = new PluginKey<DecorationSet>("dateDecorations");

// @feat date: decoration plugin — tint overdue/today date atoms inside an
// unchecked task_item (recomputes on the checkbox's setNodeMarkup, which a
// NodeView update would miss)
export function dateDecorationPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: dateDecorationKey,
    state: {
      init(_config, state: EditorState) {
        return buildDecorations(state.doc);
      },
      apply(tr: Transaction, prev: DecorationSet) {
        // Any doc change (incl. a checkbox toggle → setNodeMarkup on the
        // task_item) rebuilds; non-doc transactions keep the stable set.
        return tr.docChanged ? buildDecorations(tr.doc) : prev;
      },
    },
    props: {
      decorations(state: EditorState) {
        return dateDecorationKey.getState(state);
      },
    },
  });
}
