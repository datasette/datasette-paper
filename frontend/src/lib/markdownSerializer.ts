/**
 * Client-side markdown serializer for the paper schema — the browser mirror
 * of `datasette_paper/markdown.py`'s output shapes, built on
 * prosemirror-markdown's `defaultMarkdownSerializer` plus rules for our
 * custom nodes. Used by the doc-header "Copy markdown" button
 * (`PaperApp.copyMarkdown`) and the clipboard `text/plain` serializer for
 * selections containing a callout (`collab.ts`).
 *
 * `prosemirror-markdown` must stay lazy-loaded (it drags markdown-it,
 * ~50k gzipped), so this module never imports it at runtime — callers pass
 * the dynamically-imported module into `buildMarkdownSerializer`.
 *
 * Every node and mark in the schema has a rule — prosemirror-markdown
 * throws on a node type with no rule, which silently turned the copy
 * button into "✗ Failed" for any doc holding an uncovered node (tables,
 * then the date atom). A parity test in markdownSerializer.test.ts walks
 * the schema and fails on the next uncovered node.
 */

import type { Node as PMNode } from "prosemirror-model";
import { clampCalloutKind } from "./schema";
import { formatDateLabel, type DateAttrs } from "./dateFormat";
import { encodeFormat, type ValueFormat } from "./formatValue";
import { youtubeWatchUrl } from "./youtube";
import { tildeEncode } from "./datasetteEmbed";
import { RESERVED_FENCE_TOKENS } from "./languages";

type PMMarkdown = typeof import("prosemirror-markdown");
type MarkdownSerializer = import("prosemirror-markdown").MarkdownSerializer;
type MarkdownSerializerState = import("prosemirror-markdown").MarkdownSerializerState;

// Mirror of `json.dumps(..., sort_keys=True, ensure_ascii=False)` for the
// JSON-body fence family (paper-embed / paper-toc): recursively sort object
// keys like the backend does. (Not byte-identical — python puts a space
// after `:` and `,` — but the parser only needs *valid* JSON.)
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]]));
    }
    return v;
  });
}

// Fenced block with an info string — the ``` fence family shared by
// sql_block / source / paper-embed / paper-toc. An empty body emits the
// backend's ````info\n```` two-line form.
function fence(state: MarkdownSerializerState, node: PMNode, info: string, body: string): void {
  state.write("```" + info + "\n");
  if (body) {
    state.text(body, false);
    state.ensureNewLine();
  }
  state.write("```");
  state.closeBlock(node);
}

// Mirror of markdown.py's `_SAFE_LANG_RE` + reserved-token clamp.
const SAFE_LANG_RE = /^[^\s`=]+$/;
function safeFenceLanguage(language: unknown): string {
  const lang = typeof language === "string" ? language : "";
  if (RESERVED_FENCE_TOKENS.has(lang) || !SAFE_LANG_RE.test(lang)) return "";
  return lang;
}

// `]` inside a link label breaks the `[label](dest)` syntax — same escape
// the backend applies in `_ref_link`.
function escapeLabel(label: string): string {
  return label.replace(/\]/g, "\\]");
}

// ── date atom (mirror of date_atom.py's render_date_atom) ───────────────────

// The `date` attrs are untyped in the schema, so validate the same way the
// backend does before anything reaches the label or the URI: `date` must be a
// real YYYY-MM-DD calendar date (atom dropped otherwise), `time` a real HH:MM
// (treated as date-only otherwise).
function validYmd(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
  );
}
function validHm(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  return m !== null && Number(m[1]) < 24 && Number(m[2]) < 60;
}

// Twin of `escape_date_label` (date_atom.py): the label embeds the untrusted
// `format` string verbatim, so collapse newline runs (a blank line inside
// `[...]` closes the link) and backslash-escape the inline-markup set + link
// brackets + `<`/`>`.
const DATE_LABEL_ESCAPE = new Set("\\`*_[]<>");
function escapeDateLabel(label: string): string {
  let out = "";
  let prevNewline = false;
  for (const ch of label) {
    if (ch === "\r" || ch === "\n") {
      if (!prevNewline) {
        out += " ";
        prevNewline = true;
      }
      continue;
    }
    prevNewline = false;
    if (DATE_LABEL_ESCAPE.has(ch)) out += "\\";
    out += ch;
  }
  return out;
}

/**
 * Build the paper `MarkdownSerializer` from a loaded `prosemirror-markdown`
 * module. Cheap to call — no caching needed. Serialize with
 * `{ tightLists: true }` (see `serializeDoc`) — the backend emits tight
 * lists, and the prosemirror-markdown default is loose.
 */
// @feat copy-markdown: the serializer behind the button — a rule per schema node
export function buildMarkdownSerializer(m: PMMarkdown): MarkdownSerializer {
  const { defaultMarkdownSerializer, MarkdownSerializer } = m;

  // ── table family (mirror of markdown.py's _render_table) ──────────────────
  // The whole pipe table is built as a string (not via per-row state.render)
  // because GFM cells are single-line: cell content re-enters the serializer
  // through a throwaway one-block doc, then flattens. The helpers close over
  // `serializer` (declared below them) for that nested pass — safe because
  // they only run at serialize time, after the const initializes.

  // Inline markdown of one cell block — the client twin of the backend's
  // `_render_inlines(block.content)`: the block wrapper is dropped and its
  // inline content rides through a bare paragraph so marks still render. A
  // non-inline container (a nested list — rare in a cell) degrades to its
  // plain text, since its structure can't survive a single-line cell anyway.
  function blockInlineMd(block: PMNode): string {
    if (!block.inlineContent) return block.textContent;
    const nodes = block.type.schema.nodes;
    const doc = nodes.doc.create(null, nodes.paragraph.create(null, block.content));
    return serializeDoc(serializer, doc);
  }

  function cellText(cell: PMNode): string {
    const parts: string[] = [];
    cell.forEach((block) => {
      const s = blockInlineMd(block).trim();
      if (s) parts.push(s);
    });
    // Escape pipes (the one char that breaks a GFM cell) and collapse
    // newlines to spaces, mirroring the backend's cell_text.
    return parts.join(" ").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
  }

  // GFM pipe table: first row becomes the header iff every cell in it is a
  // `table_header`, else an empty header is synthesised (GFM requires one).
  // Rectangular-table assumption matches the backend (the editor exposes no
  // merge). A named table is preceded by the out-of-band ```paper-table
  // sidecar fence carrying `{"name": …}` — without it the name is silently
  // dropped on the round-trip, breaking `/tables/{name}` addressing.
  // @feat tables: client markdown serialization — GFM pipe table + paper-table name sidecar (mirrors markdown.py)
  function renderTable(node: PMNode): string {
    const rows: PMNode[] = [];
    node.forEach((r) => rows.push(r));
    if (!rows.length) return "";
    const cellsOf = (row: PMNode) => {
      const cs: PMNode[] = [];
      row.forEach((c) => cs.push(c));
      return cs;
    };
    const firstCells = cellsOf(rows[0]);
    const headerFirst =
      firstCells.length > 0 && firstCells.every((c) => c.type.name === "table_header");
    const width = Math.max(...rows.map((r) => r.childCount));
    const pad = (vs: string[]) => vs.concat(Array<string>(width - vs.length).fill(""));
    const header = headerFirst ? pad(firstCells.map(cellText)) : Array<string>(width).fill("");
    const body = headerFirst ? rows.slice(1) : rows;
    const out = [
      "| " + header.join(" | ") + " |",
      "| " + Array<string>(width).fill("---").join(" | ") + " |",
      ...body.map((r) => "| " + pad(cellsOf(r).map(cellText)).join(" | ") + " |"),
    ];
    const tableMd = out.join("\n");
    const name = node.attrs.name as string | null;
    if (name) {
      // No blank line between the sidecar's closing fence and the table —
      // the fence already ends the block and GFM still detects the table.
      return "```paper-table\n" + sortedJson({ name }) + "\n```\n" + tableMd;
    }
    return tableMd;
  }

  const serializer = new MarkdownSerializer(
    {
      ...defaultMarkdownSerializer.nodes,
      // Our code_block carries `language`, not the default schema's `params`.
      // @feat code-language: copy keeps the fence language (reserved/unsafe tokens clamp to plain)
      code_block(state, node) {
        fence(state, node, safeFenceLanguage(node.attrs.language), node.textContent);
      },
      // GFM-style `- [ ] foo` / `- [x] foo`. The checkbox is content, not
      // marker, so continuation lines indent by the 2-col `- ` like a bullet.
      task_list(state, node) {
        state.renderList(node, "  ", () => "");
      },
      task_item(state, node) {
        state.write(node.attrs.checked ? "- [x] " : "- [ ] ");
        state.renderContent(node);
      },
      // A lone canonical YouTube URL on its own line — the bare-URL form the
      // backend markdown round-trips. Unknown providers emit nothing.
      video_embed(state, node) {
        if ((node.attrs.provider ?? "youtube") === "youtube" && node.attrs.videoId) {
          const start = typeof node.attrs.start === "number" && node.attrs.start > 0 ? node.attrs.start : null;
          state.write(youtubeWatchUrl(node.attrs.videoId, start));
        }
        state.closeBlock(node);
      },
      // `> [!KIND] Title` marker line + `> `-quoted body, matching
      // markdown.py's callout serialization (kind UPPERCASE, title omitted
      // when empty, bad kinds clamped to note).
      // @feat callout: client markdown serialization — `> [!KIND] Title` + quoted body
      callout(state, node) {
        const kind = clampCalloutKind(node.attrs.kind).toUpperCase();
        // @feat callout: client copy emits the `-` suffix for a collapsed callout
        const fold = node.attrs.collapsed === true ? "-" : "";
        const first = node.firstChild;
        const title =
          first && first.type.name === "callout_title" ? first.textContent.trim() : "";
        state.wrapBlock("> ", null, node, () => {
          state.write(`[!${kind}]${fold}${title ? ` ${title}` : ""}`);
          state.ensureNewLine();
          node.forEach((child, _offset, index) => {
            // The title child is flattened onto the marker line above.
            if (index === 0 && child.type.name === "callout_title") return;
            state.render(child, node, index);
          });
        });
      },
      // Only reachable if a callout_title escapes its parent (the callout
      // rule skips it) — e.g. an open slice boundary. Degrade to plain text.
      callout_title(state, node) {
        state.text(node.textContent, false);
        state.closeBlock(node);
      },
      // Inline atoms — same shapes as markdown.py's `_render_inlines`.
      placeholder(state, node) {
        state.write("{{" + String(node.attrs.key ?? "") + "}}");
      },
      paper_link(state, node) {
        state.write(`[[${node.attrs.docId ?? ""}]]`);
      },
      // `[@label](paper:/actor/<id>)` — the canonical `paper:/actor/` ref the
      // parser keys off. No actor-name resolver here, so the id is the label
      // (matching the backend's no-resolver form).
      mention(state, node) {
        const id = String(node.attrs.actorId ?? "");
        state.write(`[${escapeLabel("@" + id)}](paper:/actor/${encodeURIComponent(id)})`);
      },
      tag(state, node) {
        const tag = String(node.attrs.tag ?? "");
        state.write(`[${escapeLabel("#" + tag)}](paper:/tag/${encodeURIComponent(tag)})`);
      },
      // `[ref](paper:/embed/datasette<ref>)` — no provider resolver
      // client-side, so the kind falls back to "datasette" like the backend
      // does for an unclaimed ref. Slashes stay raw; segments are encoded.
      inline_embed(state, node) {
        const ref = String(node.attrs.ref ?? "");
        const path = ref.startsWith("/") ? ref : "/" + ref;
        const encoded = path.split("/").map(encodeURIComponent).join("/");
        state.write(`[${escapeLabel(ref)}](paper:/embed/datasette${encoded})`);
      },
      // `${{source.column}}` (+ optional `| kind:arg` format suffix). A
      // column that isn't a bare `\w+` identifier wraps in `[...]` so it
      // survives the parser's grammar.
      value(state, node) {
        const source = String(node.attrs.source ?? "");
        const column = String(node.attrs.column ?? "");
        const columnMd = /^\w+$/.test(column) ? column : "[" + column + "]";
        const fmt = encodeFormat(node.attrs.format as ValueFormat);
        state.write("${{" + source + "." + columnMd + (fmt ? " | " + fmt : "") + "}}");
      },
      // ```sql db=NAME fence — `db=` is ALWAYS emitted (a bare `sql db=` for
      // a db-less block); the token is what distinguishes this from a plain
      // ```sql code block on the round-trip. Values are tilde-encoded (a db
      // name is a filename stem — it can hold spaces/anything, and a raw
      // space would inject a sibling info token); the backend parser
      // tilde-decodes, mirror of `_fence_attr_token` in markdown.py.
      sql_block(state, node) {
        let info = `sql db=${tildeEncode(String(node.attrs.db ?? ""))}`;
        if (node.attrs.hidden) info += " hidden";
        fence(state, node, info, node.textContent);
      },
      // ```source name=NAME db=DB fence — a named SQL query.
      source(state, node) {
        let info = "source";
        if (node.attrs.name) info += ` name=${tildeEncode(String(node.attrs.name))}`;
        if (node.attrs.db) info += ` db=${tildeEncode(String(node.attrs.db))}`;
        fence(state, node, info, node.textContent);
      },
      // ```paper-embed fence with a one-line JSON body of the node attrs.
      block_embed(state, node) {
        const body = sortedJson({
          ref: node.attrs.ref ?? "",
          mode: node.attrs.mode ?? "table",
          config: node.attrs.config ?? {},
        });
        fence(state, node, "paper-embed", body);
      },
      // ```paper-toc fence — empty body for the common empty config.
      toc(state, node) {
        const config = (node.attrs.config ?? {}) as Record<string, unknown>;
        fence(state, node, "paper-toc", Object.keys(config).length ? sortedJson(config) : "");
      },
      // `[label](paper:/date/<iso>[?tz=…][&fmt=…])` — twin of the backend's
      // render_date_atom, including its validate-then-drop guard: a
      // structurally invalid date emits nothing rather than a broken ref.
      // (Query params use encodeURIComponent, not byte-identical to python's
      // quote(safe='') for `!'()*` — the parser unquotes either.)
      // @feat date: client markdown serialization — [label](paper:/date/…) link (mirrors render_date_atom)
      date(state, node) {
        const date = node.attrs.date;
        if (!validYmd(date)) return;
        const time = validHm(node.attrs.time) ? node.attrs.time : null;
        const tzAttr = node.attrs.tz;
        const tz = typeof tzAttr === "string" && tzAttr ? tzAttr : null;
        const fmtAttr = node.attrs.format;
        const fmt = typeof fmtAttr === "string" && fmtAttr ? fmtAttr : null;
        const path = time ? `${date}T${time}` : date;
        const params: string[] = [];
        // tz is only meaningful with a time; a stray tz on a date-only atom
        // is dropped.
        if (time && tz) params.push(`tz=${encodeURIComponent(tz)}`);
        if (fmt) params.push(`fmt=${encodeURIComponent(fmt)}`);
        const canonical =
          `paper:/date/${path}` + (params.length ? "?" + params.join("&") : "");
        const label = escapeDateLabel(
          formatDateLabel({ date, time, tz, format: fmt } as DateAttrs),
        );
        state.write(`[${label}](${canonical})`);
      },
      table(state, node) {
        const tableMd = renderTable(node);
        // state.text (not write) so a table inside a callout keeps the
        // `> ` prefix on every line.
        if (tableMd) state.text(tableMd, false);
        state.closeBlock(node);
      },
      // Unreachable through `table` (renderTable consumes the whole subtree);
      // kept so a row/cell that escapes its table in an open slice degrades
      // to its content instead of throwing.
      table_row(state, node) {
        state.renderContent(node);
      },
      table_cell(state, node) {
        state.renderContent(node);
      },
      table_header(state, node) {
        state.renderContent(node);
      },
    },
    defaultMarkdownSerializer.marks,
  );
  return serializer;
}

/** Serialize a node with the paper house options (tight lists, matching the
 *  backend serializer). All call sites should go through this. */
export function serializeDoc(serializer: MarkdownSerializer, doc: PMNode): string {
  return serializer.serialize(doc, { tightLists: true });
}
