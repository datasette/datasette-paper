"""Server-side ProseMirror schema mirroring `frontend/src/lib/schema.ts`.

Used by the Instance to materialize the live doc by applying steps_tail
to the latest snapshot. Must match the JS schema exactly — divergence
will cause Step.apply to fail or produce silently-wrong content.

If you add nodes / marks on the JS side, mirror them here in lock-step.

Table nodes are hand-ported from `prosemirror-tables` (JS) — the Python
port has no `tableNodes` helper. The `table` node carries a custom
`name` attr used by the `/-/paper/api/docs/{id}/tables/{name}` endpoint.
`colspan`/`rowspan`/`colwidth` are kept (the JS plugin requires them)
even though we never expose merge/split UI; in practice every cell has
`colspan=rowspan=1`.
"""

import json

from prosemirror.model import Schema
from prosemirror.schema.basic import schema as basic_schema
from prosemirror.schema.list import add_list_nodes

_list_nodes = add_list_nodes(basic_schema.spec["nodes"], "paragraph block*", "block")

# Custom task_list / task_item — mirrors frontend/src/lib/schema.ts.
_task_list_spec = {
    "group": "block",
    "content": "task_item+",
    "parseDOM": [{"tag": "ul[data-task-list]"}],
    "toDOM": lambda _node: ["ul", {"data-task-list": "true"}, 0],
}

_task_item_spec = {
    "attrs": {"checked": {"default": False}},
    "content": "paragraph block*",
    "defining": True,
    "parseDOM": [{"tag": "li[data-task-item]"}],
    "toDOM": lambda node: [
        "li",
        {"data-task-item": "true", "data-checked": str(node.attrs["checked"])},
        0,
    ],
}

# Table specs — mirror prosemirror-tables `tableNodes(...)` output with
# our custom `name` attr appended on the `table` node.
_cell_attrs = {
    "colspan": {"default": 1},
    "rowspan": {"default": 1},
    "colwidth": {"default": None},
}

_table_spec = {
    "group": "block",
    "content": "table_row+",
    "tableRole": "table",
    "isolating": True,
    "attrs": {"name": {"default": None}},
    "parseDOM": [{"tag": "table"}],
    "toDOM": lambda node: [
        "table",
        ({"data-name": str(node.attrs["name"])} if node.attrs.get("name") else {}),
        ["tbody", 0],
    ],
}

_table_row_spec = {
    "content": "(table_cell | table_header)*",
    "tableRole": "row",
    "parseDOM": [{"tag": "tr"}],
    "toDOM": lambda _node: ["tr", 0],
}

_table_cell_spec = {
    "content": "block+",
    "attrs": _cell_attrs,
    "tableRole": "cell",
    "isolating": True,
    "parseDOM": [{"tag": "td"}],
    "toDOM": lambda _node: ["td", 0],
}

_table_header_spec = {
    "content": "block+",
    "attrs": _cell_attrs,
    "tableRole": "header_cell",
    "isolating": True,
    "parseDOM": [{"tag": "th"}],
    "toDOM": lambda _node: ["th", 0],
}

# Inline atom for template placeholders — mirrors the JS schema in
# frontend/src/lib/schema.ts. Authored only inside templates; the
# create-from-template route walks the materialized doc and replaces
# each placeholder with a text node using the resolver registry in
# datasette_paper/template_params.py. Docs that aren't templates
# should never contain a placeholder node; the materializer tolerates
# them either way (the node is a valid inline atom — it just won't be
# substituted outside the template-clone flow).
_placeholder_spec = {
    "group": "inline",
    "inline": True,
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {"key": {"default": ""}, "label": {"default": None}},
    "parseDOM": [{"tag": "span[data-placeholder]"}],
    "toDOM": lambda node: [
        "span",
        {
            "data-placeholder": str(node.attrs.get("key", "")),
            "class": "pm-placeholder",
        },
        "{" + str(node.attrs.get("label") or node.attrs.get("key", "")) + "}",
    ],
}

# Inline atom for cross-document links — mirrors the JS schema in
# frontend/src/lib/schema.ts. id-only (`docId`); markdown round-trips as
# `[[id]]` via datasette_paper/markdown.py. toDOM is never rendered
# server-side but must be structurally valid for node_from_json/Step.apply.
_paper_link_spec = {
    "group": "inline",
    "inline": True,
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {"docId": {"default": None}},
    "parseDOM": [{"tag": "a[data-paper-link]"}],
    "toDOM": lambda node: [
        "a",
        {
            "data-paper-link": str(node.attrs.get("docId") or ""),
            "class": "pm-paper-link",
        },
        f"Paper {node.attrs.get('docId')}",
    ],
}

# Inline atom for @mentions — mirrors the JS schema in
# frontend/src/lib/schema.ts. id-only (`actorId`); markdown round-trips as
# `[@label](actor:id)` via datasette_paper/markdown.py. toDOM is never
# rendered server-side but must be structurally valid for
# node_from_json/Step.apply.
_mention_spec = {
    "group": "inline",
    "inline": True,
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {"actorId": {"default": None}},
    "parseDOM": [{"tag": "span[data-mention]"}],
    "toDOM": lambda node: [
        "span",
        {
            "data-mention": str(node.attrs.get("actorId") or ""),
            "class": "pm-mention",
        },
        f"@{node.attrs.get('actorId')}",
    ],
}

# Inline atom for #tags — mirrors the JS schema in
# frontend/src/lib/schema.ts. value-only (`tag`); markdown round-trips as
# `[#label](tag:slug)` via datasette_paper/markdown.py. No async resolver
# (the tag is its own label). toDOM must be structurally valid for
# node_from_json/Step.apply but is never rendered server-side.
_tag_spec = {
    "group": "inline",
    "inline": True,
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {"tag": {"default": None}},
    "parseDOM": [{"tag": "span[data-tag]"}],
    "toDOM": lambda node: [
        "span",
        {
            "data-tag": str(node.attrs.get("tag") or ""),
            "class": "pm-tag",
        },
        f"#{node.attrs.get('tag')}",
    ],
}

# Inline atom for references to a Datasette resource — mirrors the JS schema
# in frontend/src/lib/schema.ts. identity-only (`ref`, a Datasette URL path);
# markdown round-trips as `[label](datasette:<path>)` via
# datasette_paper/markdown.py. The display label is resolved per-viewer by the
# NodeView and never persisted. toDOM is never rendered server-side but must be
# structurally valid for node_from_json/Step.apply.
_inline_embed_spec = {
    "group": "inline",
    "inline": True,
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {"ref": {"default": None}},
    "parseDOM": [{"tag": "a[data-inline-embed]"}],
    "toDOM": lambda node: [
        "a",
        {
            "data-inline-embed": str(node.attrs.get("ref") or ""),
            "class": "pm-inline-embed",
        },
        str(node.attrs.get("ref") or ""),
    ],
}

# Block atom for an embedded read-only render of a Datasette resource —
# mirrors the JS schema. identity-only (`ref` + `mode` + opaque `config`);
# rendered data is fetched per-viewer and never persisted. markdown round-trips
# as a ```paper-embed JSON fence via datasette_paper/markdown.py. `config` is a
# provider-defined bag carried verbatim; it survives the DOM round-trip
# JSON-stringified in `data-embed-config` (parsed defensively → {}).
_block_embed_spec = {
    "group": "block",
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {
        "ref": {"default": None},
        "mode": {"default": "table"},
        "config": {"default": {}},
    },
    # parseDOM is never exercised server-side (materialization goes through
    # node_from_json, not DOM parsing), so — like the other specs here — we
    # only declare the tag; attrs (incl. `config`) arrive via the JSON.
    "parseDOM": [{"tag": "div[data-block-embed]"}],
    "toDOM": lambda node: [
        "div",
        {
            "data-block-embed": str(node.attrs.get("ref") or ""),
            "data-embed-mode": str(node.attrs.get("mode") or "table"),
            "data-embed-config": json.dumps(node.attrs.get("config") or {}),
            "class": "pm-block-embed",
        },
        str(node.attrs.get("ref") or ""),
    ],
}

# Block node for an editable SQL query — mirrors the JS schema in
# frontend/src/lib/schema.ts. Unlike block_embed (an atom), the query is
# editable text content; `db` names the target database and `hidden` collapses
# the editor. Results are fetched per-viewer by the NodeView and never
# persisted. markdown round-trips as a ```sql db=NAME fence via
# datasette_paper/markdown.py. toDOM is never rendered server-side but must be
# structurally valid for node_from_json/Step.apply.
_sql_block_spec = {
    "group": "block",
    "content": "text*",
    "marks": "",
    "code": True,
    "defining": True,
    "selectable": True,
    "attrs": {"db": {"default": None}, "hidden": {"default": False}},
    "parseDOM": [{"tag": "pre[data-sql-block]", "preserveWhitespace": "full"}],
    "toDOM": lambda node: [
        "pre",
        {
            "data-sql-block": "true",
            "data-sql-db": str(node.attrs.get("db") or ""),
            "data-sql-hidden": str(bool(node.attrs.get("hidden"))).lower(),
            "class": "pm-sql-block",
        },
        ["code", 0],
    ],
}

_nodes = {
    **_list_nodes,
    "placeholder": _placeholder_spec,
    "paper_link": _paper_link_spec,
    "mention": _mention_spec,
    "tag": _tag_spec,
    "inline_embed": _inline_embed_spec,
    "block_embed": _block_embed_spec,
    "sql_block": _sql_block_spec,
    "task_list": _task_list_spec,
    "task_item": _task_item_spec,
    "table": _table_spec,
    "table_row": _table_row_spec,
    "table_cell": _table_cell_spec,
    "table_header": _table_header_spec,
}

schema = Schema({"nodes": _nodes, "marks": basic_schema.spec["marks"]})
