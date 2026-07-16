/**
 * @feat task-assign: shared, framework-agnostic helpers for the two TODO
 * surfaces (the `<profile-todos>` light-DOM element and the Svelte
 * `/-/paper/todos` page). Only pure data shaping lives here — the due-chip
 * label + tint, the section breadcrumb, and (for the page) the client-side
 * due-date bucketing. Rendering is each surface's own job.
 */
// Both are pure date math homed in the PM-free dateFormat.ts, so these TODO
// surfaces get the exact same label + overdue/today tint the inline date chip
// uses without pulling the NodeView + ProseMirror into their bundles.
import { classifyDate, formatDateLabel, localYmd, resolveInstant } from "./dateFormat";
import type { DateAttrs } from "./dateFormat";

export interface TodoDue {
  date: string;
  time: string | null;
  tz: string | null;
}

/** One row of the `/todos` endpoint (see routes/docs.py profile_todos). */
export interface TodoRow {
  doc_id: number;
  doc_name: string;
  doc_url: string;
  ordinal: number;
  text: string;
  checked: boolean;
  section: Array<{ level: number; text: string }>;
  assignees: string[];
  assignees_inherited: boolean;
  due: TodoDue | null;
  due_inherited: boolean;
}

export interface TodosResponse {
  actor_id: string;
  todos: TodoRow[];
}

/** The due chip's rendered label + overdue/today tint (both in the viewer's
 *  timezone), or null when the task has no due date. Reuses the exact same
 *  `formatDateLabel` / `classifyDate` the inline date chip uses, so a due date
 *  reads identically in a TODO list and in the doc. */
export function dueChip(
  due: TodoDue | null,
  now: Date,
): { label: string; tint: "overdue" | "today" | null } | null {
  if (!due) return null;
  const attrs: DateAttrs = {
    date: due.date,
    time: due.time,
    tz: due.tz,
    format: null,
  };
  return { label: formatDateLabel(attrs), tint: classifyDate(attrs, now) };
}

/** The enclosing-heading path as a "Sprint 12 › Backend" breadcrumb, or "" when
 *  the task sits before any heading. */
export function sectionBreadcrumb(
  section: Array<{ level: number; text: string }>,
): string {
  return (section ?? [])
    .map((s) => s.text)
    .filter((t) => t)
    .join(" › ");
}

export type BucketKey = "overdue" | "today" | "week" | "later" | "none";

export interface Bucket {
  key: BucketKey;
  label: string;
  rows: TodoRow[];
}

const BUCKET_LABELS: Record<BucketKey, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "This week",
  later: "Later",
  none: "No due date",
};

/** Which bucket a due date lands in, evaluated against `now` in the viewer's
 *  tz. Timed zoned values use the resolved instant's viewer-local date so the
 *  bucket agrees with the chip tint; missing/invalid zones fall back to the
 *  stored calendar date. "This week" = the next 7 calendar days after today. */
function bucketFor(due: TodoDue | null, now: Date): BucketKey {
  if (!due) return "none";
  const today = localYmd(now);
  const instant = resolveInstant({ ...due, format: null });
  const viewerDate = instant ? localYmd(instant) : due.date;
  if (viewerDate < today) return "overdue";
  if (viewerDate === today) return "today";
  const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
  if (viewerDate <= localYmd(weekEnd)) return "week";
  return "later";
}

/** Split rows into the five due-date buckets in the viewer's tz. Within a
 *  bucket: due date ascending (undated already grouped), then doc, then
 *  ordinal; done tasks sink after open ones. Empty buckets are omitted so the
 *  caller never renders a bare heading. The server already ordered by
 *  (due, doc, ordinal); the only re-sort here pushes done rows to the end
 *  within each bucket (a stable sort preserves the server order otherwise). */
export function bucketTodos(rows: TodoRow[], now: Date): Bucket[] {
  const byKey: Record<BucketKey, TodoRow[]> = {
    overdue: [],
    today: [],
    week: [],
    later: [],
    none: [],
  };
  for (const row of rows) byKey[bucketFor(row.due, now)].push(row);

  const order: BucketKey[] = ["overdue", "today", "week", "later", "none"];
  const buckets: Bucket[] = [];
  for (const key of order) {
    const bucketRows = byKey[key];
    if (bucketRows.length === 0) continue;
    // Stable sort: open before done, otherwise keep the server's ordering.
    bucketRows.sort((a, b) => Number(a.checked) - Number(b.checked));
    buckets.push({ key, label: BUCKET_LABELS[key], rows: bucketRows });
  }
  return buckets;
}
