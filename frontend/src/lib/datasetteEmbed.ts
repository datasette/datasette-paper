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
export const SOURCES_ENDPOINT = "/-/paper/api/datasette/sources";

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
  kind: string;
  label: string;
  // Core results carry the database name; provider results may instead supply
  // a free-form secondary line (e.g. "12 places"). The picker shows whichever
  // is present.
  db?: string;
  detail?: string;
};

/**
 * A browsable insert "source" contributed by a `paper_resource_provider`
 * (the backend `/sources` endpoint). Each becomes a `/`-menu command + a
 * search-and-insert dialog scoped to that provider. The built-in
 * core-Datasette embed is NOT a provider source — it has its own command.
 */
export type ProviderSource = {
  id: string;
  label: string;
  icon: string; // a TOOLBAR_ICONS key
  mode: string; // stored on the inserted datasette_embed node
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

/**
 * Search resources by name for the picker. With no `source` this searches
 * core databases / tables / views; with a provider `source` id it dispatches
 * to that provider's own search (e.g. the actor's place lists).
 */
export async function searchResources(
  q: string,
  limit = 20,
  source?: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (source) params.set("source", source);
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

/** Fetch the provider-contributed insert sources (empty on any failure). */
export async function fetchSources(): Promise<ProviderSource[]> {
  try {
    const res = await fetch(SOURCES_ENDPOINT, {
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { sources?: ProviderSource[] };
    return json.sources ?? [];
  } catch {
    return [];
  }
}
