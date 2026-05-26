"""Agent tools for datasette-agent (optional integration).

Registered via the ``register_agent_tools`` hook only when ``datasette-agent``
is installed — see the guarded import in ``__init__.py``. The tools let an LLM
create and edit paper docs through markdown.

Editing model: ``read_paper`` serialises the live doc to markdown; ``edit_paper``
and ``insert_into_paper`` do an *atomic* markdown read-modify-write via
``Instance.apply_markdown_edit`` (materialize → transform → reparse → replace,
all under the doc's write lock), so a concurrent collab edit can't be clobbered
and live editors see the change over SSE. ``append_to_paper`` reuses the append
primitive. All changes flow through the same step-log pipeline as human edits.

Permission model: ``AgentTool.required_permission`` is resource-less, so it can
only express the coarse "can create papers" gate (used by ``create_paper``).
Per-document ``view`` / ``edit`` is checked inside each tool fn and surfaced as
an ``{"error": ...}`` result rather than an exception.
"""

from __future__ import annotations

import json

from datasette_agent.tools import AgentTool

from .errors import InvalidStepError
from .instance import get_registry
from .markdown import doc_to_markdown
from .markdown_parser import markdown_to_doc, markdown_to_fragment
from .permissions import can_paper_edit, can_paper_view
from .util import paper_db


class _EditError(Exception):
    """Raised by an edit transform when it can't apply (no/ambiguous match)."""


def _actor_id(actor):
    return actor.get("id") if actor else None


def _doc_url(datasette, doc_id: int) -> str:
    return datasette.urls.path(f"/-/paper/doc/{doc_id}")


async def _load_instance(datasette, doc_id: int):
    """Return (doc_row, instance) or (None, None) if the doc doesn't exist."""
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return None, None
    instance = await get_registry(datasette).get(db, doc_id)
    return doc, instance


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------


async def _create_paper(datasette, actor, name=None, content=None):
    if content is not None and not isinstance(content, str):
        return json.dumps({"error": "content must be a string"})
    db = paper_db(datasette)
    aid = _actor_id(actor)
    doc_name = (name or "Untitled").strip() or "Untitled"
    if content:
        doc_json = markdown_to_doc(content)
        doc = await db.insert_doc_with_snapshot(
            name=doc_name,
            created_by=aid,
            kind="doc",
            snapshot_doc_json=json.dumps(doc_json),
            snapshot_actor_id=aid,
        )
    else:
        doc = await db.insert_doc(name=doc_name, created_by=aid, kind="doc")
    return json.dumps(
        {"doc_id": doc.id, "name": doc.name, "url": _doc_url(datasette, doc.id)}
    )


async def _read_paper(datasette, actor, doc_id):
    doc_id = int(doc_id)
    if not await can_paper_view(datasette, actor, doc_id):
        return json.dumps({"error": "Permission denied"})
    doc, instance = await _load_instance(datasette, doc_id)
    if doc is None:
        return json.dumps({"error": "Document not found"})
    md = doc_to_markdown(instance.materialize_live_doc())
    return json.dumps(
        {
            "doc_id": doc_id,
            "name": doc.name,
            "version": instance.version,
            "content_markdown": md,
        }
    )


async def _append_to_paper(datasette, actor, doc_id, content):
    doc_id = int(doc_id)
    if not isinstance(content, str):
        return json.dumps({"error": "content must be a string"})
    if not await can_paper_edit(datasette, actor, doc_id):
        return json.dumps({"error": "Permission denied"})
    doc, instance = await _load_instance(datasette, doc_id)
    if doc is None:
        return json.dumps({"error": "Document not found"})
    fragment = markdown_to_fragment(content)
    if not fragment:
        return json.dumps(
            {"doc_id": doc_id, "version": instance.version, "appended_blocks": 0}
        )
    try:
        new_version = await instance.append_fragment(
            fragment, actor_id=_actor_id(actor)
        )
    except InvalidStepError as exc:
        return json.dumps({"error": "invalid_content", "message": exc.message})
    return json.dumps(
        {"doc_id": doc_id, "version": new_version, "appended_blocks": len(fragment)}
    )


async def _edit_paper(datasette, actor, doc_id, old_str, new_str):
    doc_id = int(doc_id)
    if not isinstance(old_str, str) or not isinstance(new_str, str):
        return json.dumps({"error": "old_str and new_str must be strings"})
    if not old_str:
        return json.dumps({"error": "old_str must be non-empty"})
    if not await can_paper_edit(datasette, actor, doc_id):
        return json.dumps({"error": "Permission denied"})
    doc, instance = await _load_instance(datasette, doc_id)
    if doc is None:
        return json.dumps({"error": "Document not found"})

    def edit_fn(md: str) -> str:
        count = md.count(old_str)
        if count == 0:
            raise _EditError(
                "old_str not found in the document — read_paper to see the "
                "current markdown, then retry with an exact substring."
            )
        if count > 1:
            raise _EditError(
                f"old_str matches {count} places — include more surrounding "
                "text so it identifies exactly one location."
            )
        return md.replace(old_str, new_str, 1)

    return await _run_markdown_edit(datasette, instance, doc_id, edit_fn, actor)


async def _insert_into_paper(datasette, actor, doc_id, anchor, content):
    doc_id = int(doc_id)
    if not isinstance(anchor, str) or not isinstance(content, str):
        return json.dumps({"error": "anchor and content must be strings"})
    if not anchor:
        return json.dumps({"error": "anchor must be non-empty"})
    if not await can_paper_edit(datasette, actor, doc_id):
        return json.dumps({"error": "Permission denied"})
    doc, instance = await _load_instance(datasette, doc_id)
    if doc is None:
        return json.dumps({"error": "Document not found"})

    def edit_fn(md: str) -> str:
        count = md.count(anchor)
        if count == 0:
            raise _EditError(
                "anchor not found in the document — read_paper to see the "
                "current markdown, then retry with an exact substring."
            )
        if count > 1:
            raise _EditError(
                f"anchor matches {count} places — include more surrounding "
                "text so it identifies exactly one location."
            )
        idx = md.index(anchor)
        # Insert after the end of the line the anchor sits on, as a new block.
        line_end = md.find("\n", idx + len(anchor))
        if line_end == -1:
            line_end = len(md)
        block = "\n\n" + content.strip("\n") + "\n"
        return md[:line_end] + block + md[line_end:]

    return await _run_markdown_edit(datasette, instance, doc_id, edit_fn, actor)


async def _run_markdown_edit(datasette, instance, doc_id, edit_fn, actor):
    """Apply a markdown transform and return the updated doc (or an error)."""
    try:
        new_version = await instance.apply_markdown_edit(
            edit_fn, actor_id=_actor_id(actor)
        )
    except _EditError as exc:
        return json.dumps({"error": "edit_failed", "message": str(exc)})
    except InvalidStepError as exc:
        return json.dumps({"error": "invalid_result", "message": exc.message})
    md = doc_to_markdown(instance.materialize_live_doc())
    return json.dumps(
        {"doc_id": doc_id, "version": new_version, "content_markdown": md}
    )


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------

_DOC_ID = {"type": "integer", "description": "The paper document id."}


def get_paper_agent_tools() -> list[AgentTool]:
    return [
        AgentTool(
            name="create_paper",
            description=(
                "Create a new paper document, optionally seeded with markdown "
                "content. Returns the new doc_id and a URL to open it."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Title for the new document.",
                    },
                    "content": {
                        "type": "string",
                        "description": "Optional initial body as markdown.",
                    },
                },
            },
            fn=_create_paper,
            required_permission="datasette-paper-create",
        ),
        AgentTool(
            name="read_paper",
            description=(
                "Read a paper document as markdown. Call this before editing so "
                "you have the exact current text to target with edit_paper."
            ),
            input_schema={
                "type": "object",
                "properties": {"doc_id": _DOC_ID},
                "required": ["doc_id"],
            },
            fn=_read_paper,
        ),
        AgentTool(
            name="append_to_paper",
            description="Append markdown content to the end of a paper document.",
            input_schema={
                "type": "object",
                "properties": {
                    "doc_id": _DOC_ID,
                    "content": {
                        "type": "string",
                        "description": "Markdown to append as new blocks.",
                    },
                },
                "required": ["doc_id", "content"],
            },
            fn=_append_to_paper,
        ),
        AgentTool(
            name="edit_paper",
            description=(
                "Replace an exact, unique run of text in a paper document. "
                "old_str must match exactly once — include enough surrounding "
                "text to be unique. Operates on the document's markdown; "
                "read_paper first to get the exact text. Returns the updated "
                "markdown."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "doc_id": _DOC_ID,
                    "old_str": {
                        "type": "string",
                        "description": "Exact text to replace (must be unique).",
                    },
                    "new_str": {
                        "type": "string",
                        "description": "Replacement text (markdown).",
                    },
                },
                "required": ["doc_id", "old_str", "new_str"],
            },
            fn=_edit_paper,
        ),
        AgentTool(
            name="insert_into_paper",
            description=(
                "Insert markdown content as new blocks immediately after the "
                "block containing an anchor string. anchor must match exactly "
                "once. Returns the updated markdown."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "doc_id": _DOC_ID,
                    "anchor": {
                        "type": "string",
                        "description": "Unique existing text to insert after.",
                    },
                    "content": {
                        "type": "string",
                        "description": "Markdown to insert as new blocks.",
                    },
                },
                "required": ["doc_id", "anchor", "content"],
            },
            fn=_insert_into_paper,
        ),
    ]
