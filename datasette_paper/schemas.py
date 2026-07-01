"""Pydantic request-body models for datasette-paper route handlers.

These are injected by ``datasette-plugin-router`` via ``Annotated[Model, Body()]``
parameters: the router parses and validates the JSON request body and passes the
model instance to the handler (replacing the old ``read_json_body`` helper). A
malformed body or a type/shape error is turned into a ``400`` by the router, so
handlers no longer guard JSON parsing themselves.

Some fields are deliberately left ``Any``-typed rather than strict ``str``/``int``:
those are ones whose handler still owns an exact, user-facing ``400`` message
(e.g. ``"invalid tag"``, ``"content (string) is required"``). Keeping the field
loose lets the raw value reach the handler unchanged so its message stays
byte-identical. Fields that are purely structural (presence/events numerics) get
strict types and let the router emit the ``400``.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator


class IdsBody(BaseModel):
    """``{"ids": [...]}`` for the link/actor resolve endpoints.

    Both callers slice to 200 and coerce each entry themselves (``int()`` /
    ``str()``), silently dropping whatever doesn't convert — so ``ids`` stays
    ``list[Any]`` and that logic remains in the handler. The before-validator
    replicates the old ``body.get("ids") or []``: a JSON ``null`` (or any falsy
    value) becomes an empty list rather than a validation error.
    """

    ids: list[Any] = []

    @field_validator("ids", mode="before")
    @classmethod
    def _none_to_empty(cls, v):
        return v or []


class TagBody(BaseModel):
    """``{"tag": "..."}`` for the add/remove single-tag endpoints.

    ``Any`` so a non-string tag still reaches ``normalize_tag`` (which ``str()``s
    it) and the handler keeps returning the exact ``"invalid tag"`` 400.
    """

    tag: Any = None


class ReplaceDocTagsBody(BaseModel):
    """``{"tags": [...]}`` — full tag-set replacement.

    No 200 cap (unlike the resolve endpoints); the handler normalizes, dedupes
    and drops invalid entries. ``null`` → ``[]`` clears all tags.
    """

    tags: list[Any] = []

    @field_validator("tags", mode="before")
    @classmethod
    def _none_to_empty(cls, v):
        return v or []


class AuthorBody(BaseModel):
    """``{"actor_id": "..."}`` for the author add/remove endpoints.

    ``Any`` so the handler owns the exact ``"invalid actor_id"`` 400 after
    ``str().strip()`` (mirrors ``TagBody``).
    """

    actor_id: Any = None


class ReplaceAuthorsBody(BaseModel):
    """``{"authors": [...]}`` — full ordered byline replacement (reorder + set).

    The handler dedupes preserving order and validates every id against the
    eligible set (grandfathering already-credited authors). ``null`` → ``[]``
    clears the byline.
    """

    authors: list[Any] = []

    @field_validator("authors", mode="before")
    @classmethod
    def _none_to_empty(cls, v):
        return v or []


class CreateDocBody(BaseModel):
    """``POST /api/docs`` body.

    Defaults + loose typing only. Every cross-field rule (``kind`` validity,
    ``template_id``/``content`` mutual exclusion, ``content_type``, the
    ``template_id`` int coercion) and the template DB lookups stay in the handler
    so its exact 400 messages are preserved. ``template_id`` and ``content`` are
    ``Any`` so the handler's own ``int()`` / ``isinstance`` checks produce those
    messages.
    """

    name: str = "Untitled"
    kind: str = "doc"
    template_id: Optional[Any] = None
    content: Optional[Any] = None
    content_type: Optional[str] = None


class RenameDocBody(BaseModel):
    """``{"name": "..."}`` — the handler trims and rejects empty with
    ``"name is required"``."""

    name: Optional[str] = None


class AppendDocBody(BaseModel):
    """``{"content": "...", "content_type": "markdown"}`` for the append API.

    ``content`` is ``Any`` so a missing/non-string value hits the handler's
    ``"content (string) is required"`` 400 rather than a generic type error.
    """

    content: Optional[Any] = None
    content_type: Optional[str] = None


class PresenceBody(BaseModel):
    """Caret/selection presence ping — all three required ints. ``clientID``
    keeps its camelCase wire name via an alias."""

    client_id: int = Field(alias="clientID")
    anchor: int
    head: int


class EventsBody(BaseModel):
    """Collab step batch.

    ``steps`` is ``list[Any]`` on purpose: each element is an *opaque,
    JSON-serialized* ProseMirror step (the client sends a list of strings), and
    ``Instance.add_events`` parses + validates them, raising the domain errors
    the handler maps to 409/400/410/422. Constraining the element type here would
    move step-shape rejection from the handler's 422 to a router 400.
    """

    version: int
    client_id: int = Field(alias="clientID")
    steps: list[Any]
