/**
 * Command + fetch helpers for the `datasette_embed` block node and the shared
 * resource picker. Mirrors `image.ts`: the NodeView (datasetteEmbedView.ts)
 * renders, this module owns the insert command and the network calls.
 *
 * The node stores only `ref` (a Datasette URL path) and `mode`; the rendered
 * table/row payload is fetched per viewer at mount time and never persisted —
 * the same id-only discipline mentions and wikilinks follow.
 */
import { schema } from "./schema";
import type { Command } from "prosemirror-state";

export const EMBED_ENDPOINT = "/-/paper/api/datasette/embed";
export const SEARCH_ENDPOINT = "/-/paper/api/datasette/search";

/** A JSON-safe cell value: sqlite scalars, or a {$base64} envelope for blobs. */
export type CellValue = string | number | boolean | null | { $base64: true; encoded: string };

export type EmbedPayload =
  | {
      status: "ok";
      kind: "table" | "view";
      label: string;
      db: string;
      columns: string[];
      rows: CellValue[][];
      count: number | null;
      truncated: boolean;
      href: string;
    }
  | {
      status: "ok";
      kind: "row";
      label: string;
      db: string;
      table: string;
      pk: string;
      fields: { column: string; value: CellValue }[];
      href: string;
    }
  | {
      status: "ok";
      kind: "database";
      label: string;
      db: string;
      tables: {
        name: string;
        kind: "table" | "view";
        ref: string;
        href: string;
        count?: number | null;
      }[];
      href: string;
    }
  | ExternalEmbedPayload
  | { status: "denied" }
  | { status: "not_found" };

/**
 * Identity payload for a ref owned by a third-party provider (e.g.
 * datasette-places). `kind` is the provider's kind; a registered frontend
 * renderer (see embedRegistry.ts) draws the body and fetches its own data.
 */
export type ExternalEmbedPayload = {
  status: "ok";
  kind: string;
  label: string;
  href: string;
  icon?: string;
};

export type SearchResult = {
  ref: string;
  kind: "table" | "view" | "database";
  label: string;
  db: string;
};

/** bootstrap-icon name to show for each resolved resource kind. */
export function kindIcon(kind: string | undefined): string {
  switch (kind) {
    case "database":
      return "database";
    case "view":
      return "eye";
    case "row":
      return "fileText";
    default:
      return "table";
  }
}

/** Render a JSON-safe cell value as a display string (never HTML). */
export function cellText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "object") return "[binary]";
  return String(value);
}

/** A ProseMirror command that inserts a `datasette_embed` block at the selection. */
export function insertDatasetteEmbed(ref: string, mode = "table"): Command {
  return (state, dispatch) => {
    const node = schema.nodes.datasette_embed.create({ ref, mode });
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

/** Fetch the read-only render payload for a ref. Network/!ok → not_found. */
export async function fetchEmbed(ref: string, limit?: number): Promise<EmbedPayload> {
  const params = new URLSearchParams({ ref });
  if (limit != null) params.set("limit", String(limit));
  try {
    const res = await fetch(`${EMBED_ENDPOINT}?${params.toString()}`, {
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return { status: "not_found" };
    return (await res.json()) as EmbedPayload;
  } catch {
    return { status: "not_found" };
  }
}

/** Search visible databases / tables / views by name for the picker. */
export async function searchResources(q: string, limit = 20): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  try {
    const res = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { results?: SearchResult[] };
    return json.results ?? [];
  } catch {
    return [];
  }
}
