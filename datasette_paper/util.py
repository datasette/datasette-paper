"""Shared helpers for datasette-paper route handlers."""

from __future__ import annotations

import json
import re

from datasette_user_profiles import resolve_profile_actors

from .db import PaperDB

MAX_TAG_LEN = 64
_TAG_ALLOWED = re.compile(r"[^a-z0-9/_-]+")
_TAG_WS = re.compile(r"\s+")


async def read_json_body(request) -> dict:
    """Parse the request body as JSON and return a dict."""
    return json.loads(await request.post_body())


def normalize_tag(raw) -> str | None:
    """Normalize a user-supplied tag to its canonical stored form.

    Trim, lowercase, collapse internal whitespace to ``-``, and drop any
    character outside ``[a-z0-9/_-]`` (``/`` is kept so nested-tag syntax —
    e.g. ``inbox/to-read`` — survives for the inline #tag feature). Collapses
    repeated/leading/trailing dashes. Returns ``None`` when the result is
    empty or exceeds ``MAX_TAG_LEN`` so callers can reject with a 400.
    """
    if raw is None:
        return None
    s = _TAG_WS.sub("-", str(raw).strip().lower())
    s = _TAG_ALLOWED.sub("", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    if not s or len(s) > MAX_TAG_LEN:
        return None
    return s


def empty_doc_json() -> dict:
    """Return a minimal ProseMirror document structure."""
    return {"type": "doc", "content": [{"type": "paragraph"}]}


def actor_id(request) -> str | None:
    """Return the actor id from the request, or None if not authenticated."""
    return str(request.actor.get("id")) if request.actor else None


async def resolve_actor_profiles(datasette, actor_ids) -> dict[str, dict]:
    """Map actor ids to ``{"name", "avatar_url"}`` for the unique, non-falsy ids.

    datasette-user-profiles deliberately does **not** implement Datasette's
    core ``actors_from_ids`` hook (it's ``firstresult=True``, so registering it
    would lock out every other identity source), so we query its
    ``resolve_profile_actors`` helper directly. Anything it doesn't resolve
    falls back through the core ``actors_from_ids`` hook, and finally to the
    actor id itself — so an actor with no profile still resolves to its own id
    (``name``) rather than going blank.

    ``avatar_url`` is only present for actors a profile source resolves with one
    (it may still 404 if the user has no photo/icon — the UI degrades by hiding
    a broken image), and is ``None`` otherwise.
    """
    ids = {str(a) for a in actor_ids if a}
    if not ids:
        return {}

    info: dict[str, dict] = dict(await resolve_profile_actors(datasette, ids) or {})

    # Fill any ids the profiles plugin didn't resolve via the core hook
    # (its default impl returns just ``{"id": id}``).
    missing = ids - set(info)
    if missing:
        info.update(await datasette.actors_from_ids(missing) or {})

    profiles: dict[str, dict] = {}
    for actor_id in ids:
        i = info.get(actor_id) or {}
        profiles[actor_id] = {
            "name": (
                i.get("display_name") or i.get("name") or i.get("username") or actor_id
            ),
            "avatar_url": i.get("avatar_url"),
        }
    return profiles


def paper_db(datasette) -> PaperDB:
    """Return a ``PaperDB`` wrapping Datasette's internal database.

    Migrations run once at startup via the plugin's ``startup`` hook —
    callers don't need to wait for them.
    """
    return PaperDB(datasette.get_internal_database())
