"""Shared helpers for datasette-paper route handlers."""

from __future__ import annotations

import json

from .db import PaperDB


async def read_json_body(request) -> dict:
    """Parse the request body as JSON and return a dict."""
    return json.loads(await request.post_body())


def empty_doc_json() -> dict:
    """Return a minimal ProseMirror document structure."""
    return {"type": "doc", "content": [{"type": "paragraph"}]}


def actor_id(request) -> str | None:
    """Return the actor id from the request, or None if not authenticated."""
    return request.actor.get("id") if request.actor else None


def paper_db(datasette) -> PaperDB:
    """Return a ``PaperDB`` wrapping Datasette's internal database.

    Migrations run once at startup via the plugin's ``startup`` hook —
    callers don't need to wait for them.
    """
    return PaperDB(datasette.get_internal_database())
