"""Server-side ProseMirror schema mirroring `frontend/src/lib/schema.ts`.

Used by the Instance to materialize the live doc by applying steps_tail
to the latest snapshot. Must match the JS schema exactly — divergence
will cause Step.apply to fail or produce silently-wrong content.

If you add nodes / marks on the JS side, mirror them here in lock-step.
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

_nodes_with_tasks = {
    **_list_nodes,
    "task_list": _task_list_spec,
    "task_item": _task_item_spec,
}

schema = Schema({"nodes": _nodes_with_tasks, "marks": basic_schema.spec["marks"]})
