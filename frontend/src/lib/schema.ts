import { Schema, type MarkSpec, type NodeSpec } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { tableNodes } from "prosemirror-tables";

const baseNodes = addListNodes(basic.spec.nodes, "paragraph block*", "block");

// `prosemirror-schema-basic` ships `code` without `inclusive: false`, so the
// mark extends across the boundary when the cursor sits next to an existing
// inline-code span — meaning typing plain text adjacent to code silently
// becomes code. Override it to match how `link` already behaves.
const codeBase = basic.spec.marks.get("code") as MarkSpec;
const baseMarks = basic.spec.marks.update("code", { ...codeBase, inclusive: false });

// Inline atom for template placeholders — e.g. {today}, {actor}. Only
// authored inside templates; substituted server-side at
// create-from-template time so resulting docs never contain a
// `placeholder` node. Mirrors datasette_paper/pm_schema.py;
// datasette_paper/markdown.py round-trips it as `{{key}}` literal.
const placeholderNode: NodeSpec = {
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { key: { default: "" }, label: { default: null } },
  parseDOM: [
    {
      tag: "span[data-placeholder]",
      getAttrs: (el) => {
        const dom = el as HTMLElement;
        const key = dom.getAttribute("data-placeholder") ?? "";
        const label = dom.getAttribute("data-placeholder-label");
        return { key, label: label && label.length ? label : null };
      },
    },
  ],
  toDOM: (node) => {
    const attrs: Record<string, string> = {
      "data-placeholder": String(node.attrs.key ?? ""),
      class: "pm-placeholder",
    };
    if (node.attrs.label) attrs["data-placeholder-label"] = String(node.attrs.label);
    return ["span", attrs, `{${node.attrs.label ?? node.attrs.key}}`];
  },
};

// Inline atom for cross-document links — id-only (`docId`), authored via the
// `[[` autocomplete (later task) and rendered by a NodeView (TASK-04). The
// toDOM here is a static fallback. Mirrors datasette_paper/pm_schema.py;
// datasette_paper/markdown.py round-trips it as `[[id]]`.
const paperLinkNode: NodeSpec = {
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { docId: { default: null } },
  parseDOM: [
    {
      tag: "a[data-paper-link]",
      getAttrs: (el) => {
        const docId = (el as HTMLElement).getAttribute("data-paper-link");
        return { docId: docId ? Number(docId) : null };
      },
    },
  ],
  toDOM: (node) => [
    "a",
    {
      "data-paper-link": String(node.attrs.docId ?? ""),
      class: "pm-paper-link",
      href: node.attrs.docId ? `/-/paper/doc/${node.attrs.docId}` : "#",
    },
    `Paper ${node.attrs.docId ?? "?"}`,
  ],
};

// Inline atom for @mentions — id-only (`actorId`), authored via the `@`
// autocomplete and rendered by a NodeView (mentionView.ts). The toDOM here is
// a static fallback. Mirrors datasette_paper/pm_schema.py;
// datasette_paper/markdown.py round-trips it as `[@label](actor:id)`.
const mentionNode: NodeSpec = {
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { actorId: { default: null } },
  parseDOM: [
    {
      tag: "span[data-mention]",
      getAttrs: (el) => ({
        actorId: (el as HTMLElement).getAttribute("data-mention") || null,
      }),
    },
  ],
  toDOM: (node) => [
    "span",
    {
      "data-mention": String(node.attrs.actorId ?? ""),
      class: "pm-mention",
    },
    `@${node.attrs.actorId ?? "?"}`,
  ],
};

// Inline atom for #tags — value-only (`tag`), authored via the `#`
// autocomplete and rendered by a NodeView (tagView.ts). The toDOM here is a
// static fallback. Mirrors datasette_paper/pm_schema.py;
// datasette_paper/markdown.py round-trips it as `[#label](tag:slug)`. Unlike
// mentions there is no async resolver — the tag is its own label.
const tagNode: NodeSpec = {
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { tag: { default: null } },
  parseDOM: [
    {
      tag: "span[data-tag]",
      getAttrs: (el) => ({
        tag: (el as HTMLElement).getAttribute("data-tag") || null,
      }),
    },
  ],
  toDOM: (node) => [
    "span",
    {
      "data-tag": String(node.attrs.tag ?? ""),
      class: "pm-tag",
    },
    `#${node.attrs.tag ?? "?"}`,
  ],
};

// Inline atom for references to a Datasette resource (db/table/view/row or a
// sibling-plugin resource) — identity-only (`ref`, a Datasette URL path),
// authored via context-aware URL paste and rendered by a NodeView
// (inlineEmbedView.ts) that resolves a live display label. The toDOM here is
// a static fallback. Mirrors datasette_paper/pm_schema.py;
// datasette_paper/markdown.py round-trips it as
// `[label](paper:/embed/<kind>/<ref>)`.
const inlineEmbedNode: NodeSpec = {
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { ref: { default: null } },
  parseDOM: [
    {
      tag: "a[data-inline-embed]",
      getAttrs: (el) => ({
        ref: (el as HTMLElement).getAttribute("data-inline-embed") || null,
      }),
    },
  ],
  toDOM: (node) => [
    "a",
    {
      "data-inline-embed": String(node.attrs.ref ?? ""),
      class: "pm-inline-embed",
      href: node.attrs.ref ?? "#",
    },
    String(node.attrs.ref ?? "?"),
  ],
};

// Block atom for an embedded read-only render of a Datasette resource —
// identity-only (`ref` + `mode`); rendered data is fetched per-viewer by a
// NodeView (blockEmbedView.ts) and never persisted in attrs. The toDOM
// here is a static fallback. Mirrors datasette_paper/pm_schema.py;
// datasette_paper/markdown.py round-trips it as a ```paper-embed JSON fence.
const blockEmbedNode: NodeSpec = {
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  // `config` is an opaque provider-defined bag (column selection, sort, …)
  // carried in the markdown `paper-embed` fence; core paper just stores and
  // round-trips it. It survives the DOM round-trip JSON-stringified in
  // `data-embed-config` (parsed defensively → {} on malformed input).
  attrs: {
    ref: { default: null },
    mode: { default: "table" },
    config: { default: {} },
  },
  parseDOM: [
    {
      tag: "div[data-block-embed]",
      getAttrs: (el) => ({
        ref: (el as HTMLElement).getAttribute("data-block-embed") || null,
        mode: (el as HTMLElement).getAttribute("data-embed-mode") || "table",
        config: parseEmbedConfig(
          (el as HTMLElement).getAttribute("data-embed-config"),
        ),
      }),
    },
  ],
  toDOM: (node) => [
    "div",
    {
      "data-block-embed": String(node.attrs.ref ?? ""),
      "data-embed-mode": String(node.attrs.mode ?? "table"),
      "data-embed-config": JSON.stringify(node.attrs.config ?? {}),
      class: "pm-block-embed",
    },
    String(node.attrs.ref ?? "?"),
  ],
};

/** Parse the `data-embed-config` JSON blob, falling back to {} on any error. */
function parseEmbedConfig(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// Block node for an editable SQL query run against a named Datasette
// database. Unlike `block_embed` (an atom holding only a `ref`), the query is
// editable text content — it collaborates via the step log like any
// paragraph. `db` names the target database; `hidden` collapses the editor to
// a results-only view. Results are fetched per-viewer by a NodeView
// (sqlBlockView.ts) and never persisted. Mirrors datasette_paper/pm_schema.py;
// datasette_paper/markdown.py round-trips it as a ```sql db=NAME fence.
const sqlBlockNode: NodeSpec = {
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  selectable: true,
  attrs: { db: { default: null }, hidden: { default: false } },
  parseDOM: [
    {
      tag: "pre[data-sql-block]",
      preserveWhitespace: "full",
      getAttrs: (el) => ({
        db: (el as HTMLElement).getAttribute("data-sql-db") || null,
        hidden: (el as HTMLElement).getAttribute("data-sql-hidden") === "true",
      }),
    },
  ],
  toDOM: (node) => [
    "pre",
    {
      "data-sql-block": "true",
      "data-sql-db": String(node.attrs.db ?? ""),
      "data-sql-hidden": String(!!node.attrs.hidden),
      class: "pm-sql-block",
    },
    ["code", 0],
  ],
};

const taskNodes: Record<string, NodeSpec> = {
  task_list: {
    group: "block",
    content: "task_item+",
    parseDOM: [{ tag: "ul[data-task-list]" }],
    toDOM: () => ["ul", { "data-task-list": "true" }, 0],
  },
  task_item: {
    attrs: { checked: { default: false } },
    content: "paragraph block*",
    defining: true,
    parseDOM: [
      {
        tag: "li[data-task-item]",
        getAttrs: (el) => {
          const dom = el as HTMLElement;
          return { checked: dom.getAttribute("data-checked") === "true" };
        },
      },
    ],
    toDOM: (node) => [
      "li",
      {
        "data-task-item": "true",
        "data-checked": String(node.attrs.checked),
      },
      0,
    ],
  },
};

// `tableNodes` ships the table/table_row/table_cell/table_header specs.
// We append a custom `name` attribute on the `table` node — user-supplied,
// optional — that the `/-/paper/api/docs/{id}/tables/{name}` endpoint
// uses to address a specific table. The attr lives on the node so it
// rides through ProseMirror steps like any other doc content.
const tNodes = tableNodes({ tableGroup: "block", cellContent: "block+", cellAttributes: {} });
const tableSpec = tNodes.table as NodeSpec;
const tableWithName: NodeSpec = {
  ...tableSpec,
  attrs: { ...(tableSpec.attrs ?? {}), name: { default: null } },
  parseDOM: [
    {
      tag: "table",
      getAttrs: (el) => {
        const dom = el as HTMLElement;
        const name = dom.getAttribute("data-name");
        return { name: name && name.length ? name : null };
      },
    },
  ],
  toDOM: (node) => {
    const attrs: Record<string, string> = {};
    if (node.attrs.name) attrs["data-name"] = String(node.attrs.name);
    return ["table", attrs, ["tbody", 0]];
  },
};

export const schema = new Schema({
  nodes: baseNodes
    .append({ placeholder: placeholderNode })
    .append({ paper_link: paperLinkNode })
    .append({ mention: mentionNode })
    .append({ tag: tagNode })
    .append({ inline_embed: inlineEmbedNode })
    .append({ block_embed: blockEmbedNode })
    .append({ sql_block: sqlBlockNode })
    .append(taskNodes)
    .append({ ...tNodes, table: tableWithName }),
  marks: baseMarks,
});
