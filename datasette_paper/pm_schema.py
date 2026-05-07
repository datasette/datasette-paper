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

_nodes = {
    **_list_nodes,
    "task_list": _task_list_spec,
    "task_item": _task_item_spec,
    "table": _table_spec,
    "table_row": _table_row_spec,
    "table_cell": _table_cell_spec,
    "table_header": _table_header_spec,
}

schema = Schema({"nodes": _nodes, "marks": basic_schema.spec["marks"]})
