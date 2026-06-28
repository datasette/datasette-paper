/**
 * Pure, client-side serializers for a fetched result set (columns + rows),
 * shared by the SQL block (`sqlBlockView.ts`) and the table `block_embed`
 * (`blockEmbedView.ts`).
 *
 * Both blocks hold `CellValue[][]` rows with the `{$base64}` binary envelope;
 * binary cells serialize as the literal `[binary]` (matching `cellText`). These
 * functions never touch the network or the DOM — callers handle clipboard /
 * download and any "this is only the visible page" labelling.
 */
import type { CellValue } from "./datasetteEmbed";

function csvCell(v: CellValue): string {
  const s = v === null ? "" : typeof v === "object" ? "[binary]" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize columns + rows as CSV (RFC-4180-ish quoting). */
export function rowsToCsv(columns: string[], rows: CellValue[][]): string {
  const head = columns.map(csvCell).join(",");
  const body = rows.map((r) => r.map(csvCell).join(",")).join("\n");
  return body ? `${head}\n${body}` : head;
}

/** Serialize columns + rows as pretty JSON (array of column-keyed objects). */
export function rowsToJson(columns: string[], rows: CellValue[][]): string {
  const objects = rows.map((r) =>
    Object.fromEntries(
      columns.map((c, i) => {
        const v = r[i];
        return [c, v !== null && typeof v === "object" ? "[binary]" : v];
      }),
    ),
  );
  return JSON.stringify(objects, null, 2);
}
