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
    .append(taskNodes)
    .append({ ...tNodes, table: tableWithName }),
  marks: baseMarks,
});
