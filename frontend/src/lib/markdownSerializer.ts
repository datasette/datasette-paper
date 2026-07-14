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
 * Deliberately NOT covered: the table family. Serializing a selection that
 * contains a table throws (prosemirror-markdown errors on a node type with
 * no rule), and both call sites catch and fall back — plain text for the
 * clipboard, a `false` return for the copy button.
 */

import type { Node as PMNode } from "prosemirror-model";
import { clampCalloutKind } from "./schema";
import { encodeFormat, type ValueFormat } from "./formatValue";
import { youtubeWatchUrl } from "./youtube";
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

/**
 * Build the paper `MarkdownSerializer` from a loaded `prosemirror-markdown`
 * module. Cheap to call — no caching needed. Serialize with
 * `{ tightLists: true }` (see `serializeDoc`) — the backend emits tight
 * lists, and the prosemirror-markdown default is loose.
 */
export function buildMarkdownSerializer(m: PMMarkdown): MarkdownSerializer {
  const { defaultMarkdownSerializer, MarkdownSerializer } = m;
  return new MarkdownSerializer(
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
      // ```sql code block on the round-trip.
      sql_block(state, node) {
        let info = `sql db=${node.attrs.db ?? ""}`;
        if (node.attrs.hidden) info += " hidden";
        fence(state, node, info, node.textContent);
      },
      // ```source name=NAME db=DB fence — a named SQL query.
      source(state, node) {
        let info = "source";
        if (node.attrs.name) info += ` name=${node.attrs.name}`;
        if (node.attrs.db) info += ` db=${node.attrs.db}`;
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
    },
    defaultMarkdownSerializer.marks,
  );
}

/** Serialize a node with the paper house options (tight lists, matching the
 *  backend serializer). All call sites should go through this. */
export function serializeDoc(serializer: MarkdownSerializer, doc: PMNode): string {
  return serializer.serialize(doc, { tightLists: true });
}
