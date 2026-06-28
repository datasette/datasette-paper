"""Shared pytest fixtures for datasette-paper.

The default ``ds`` / ``ds_paper`` fixtures pre-bind a signed actor cookie
for ``alice`` to every ``ds.client.get`` / ``ds.client.post`` call. This
is required because per-paper ``view`` / ``edit`` permissions are gated
by ownership (``_datasette_paper_doc.created_by``) and anonymous actors
never own anything. Tests that need a stranger or anonymous request
should pass an explicit ``cookies={"ds_actor": ...}`` (the cookie value
overrides the fixture's default).

For the deny-path coverage in ``tests/test_permissions.py``, build the
Datasette instance directly without going through these fixtures.
"""

from __future__ import annotations

import json

import pytest_asyncio
from datasette.app import Datasette

from datasette_acl.grants import Principal, grant, revoke
from datasette_paper.db import PaperDB
from datasette_paper.instance import get_registry
from datasette_paper.permissions import (
    PAPER_DOC_RESOURCE_TYPE,
    PAPER_DOCS_PARENT,
)


DEFAULT_ACTOR_ID = "alice"


def make_datasette(*, granted: bool = True) -> Datasette:
    """Construct an in-memory Datasette with the paper permissions flagged.

    *granted=True* grants ``datasette-paper-create`` to everyone (matching the
    dev / e2e setup). Listing is ungated. Per-paper ``view`` / ``edit`` /
    ``manage`` are resolved by datasette-acl grants on the ``paper-doc``
    resource (the owner gets a Manager grant seeded on create).

    *granted=False* leaves all paper permissions unset.
    """
    config = (
        {
            "permissions": {
                "datasette-paper-create": True,
            }
        }
        if granted
        else {}
    )
    return Datasette(memory=True, config=config)


def _bind_default_actor(ds: Datasette, actor_id: str) -> None:
    """Monkey-patch ``ds.client.get`` / ``post`` to inject an actor cookie.

    Tests passing an explicit ``ds_actor`` cookie override the default —
    the merge favors the caller's value.
    """
    cookie = ds.sign({"a": {"id": actor_id}}, "actor")
    orig_get = ds.client.get
    orig_post = ds.client.post

    def _merge(kwargs):
        cookies = dict(kwargs.get("cookies") or {})
        cookies.setdefault("ds_actor", cookie)
        kwargs["cookies"] = cookies
        return kwargs

    async def _get(path, **kw):
        return await orig_get(path, **_merge(kw))

    async def _post(path, **kw):
        return await orig_post(path, **_merge(kw))

    ds.client.get = _get  # type: ignore[method-assign]
    ds.client.post = _post  # type: ignore[method-assign]


async def setup_paper_datasette(
    *, granted: bool = True, actor: str | None = DEFAULT_ACTOR_ID
):
    """Construct + run startup hooks + return ``(datasette, paper_db)``.

    ``actor=None`` skips the cookie binding so the test client makes
    truly anonymous requests.
    """
    ds = make_datasette(granted=granted)
    await ds.invoke_startup()
    if actor is not None:
        _bind_default_actor(ds, actor)
    return ds, PaperDB(ds.get_internal_database())


async def build_ds(*, granted: bool = True, config: dict | None = None) -> Datasette:
    """Construct + run startup hooks + return the ``Datasette`` only.

    Unlike :func:`setup_paper_datasette` this does *not* bind a default
    actor cookie — call sites sign their own per-actor cookies. *granted=True*
    grants ``datasette-paper-create`` to everyone; *config* (a top-level
    Datasette config dict) is merged on top, so callers can supply a custom
    ``permissions`` block or plugin settings.
    """
    base: dict = {}
    if granted:
        base["permissions"] = {"datasette-paper-create": True}
    if config:
        base.update(config)
    ds = Datasette(memory=True, config=base)
    await ds.invoke_startup()
    return ds


def actor_cookie(ds: Datasette, actor_id: str) -> dict:
    """A ``cookies=`` dict carrying a signed ``ds_actor`` for *actor_id*."""
    return {"ds_actor": ds.sign({"a": {"id": actor_id}}, "actor")}


async def create_doc(
    ds: Datasette,
    name: str = "Doc",
    *,
    actor_id: str = DEFAULT_ACTOR_ID,
    kind: str | None = None,
) -> int:
    """POST ``/-/paper/api/docs`` as *actor_id*; return the new doc id."""
    body: dict = {"name": name}
    if kind is not None:
        body["kind"] = kind
    resp = await ds.client.post(
        "/-/paper/api/docs",
        json=body,
        cookies=actor_cookie(ds, actor_id),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def grant_role(
    ds: Datasette,
    doc_id: int,
    actor_id: str,
    role: str = "Viewer",
    by: str = "alice",
) -> None:
    """Grant *actor_id* an acl *role* (Viewer/Editor/Manager) on the doc."""
    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.actor(actor_id),
        role=role,
        by_actor=by,
    )


async def revoke_role(
    ds: Datasette,
    doc_id: int,
    actor_id: str,
    role: str = "Viewer",
    by: str = "alice",
) -> None:
    """Revoke *actor_id*'s acl grants on the doc."""
    await revoke(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.actor(actor_id),
        by_actor=by,
    )


async def plant_snapshot(
    ds: Datasette,
    doc_id: int,
    doc_json,
    *,
    version: int = 0,
    actor_id: str | None = None,
    replace: bool = False,
) -> None:
    """Insert a snapshot and force the registry to re-hydrate from it.

    *doc_json* may be a dict (serialized here) or a JSON string. With
    *replace=True* existing snapshot rows for the doc are deleted first
    (e.g. to overwrite a template's empty seed snapshot).
    """
    if not isinstance(doc_json, str):
        doc_json = json.dumps(doc_json)
    db = PaperDB(ds.get_internal_database())
    if replace:
        await ds.get_internal_database().execute_write(
            "DELETE FROM _datasette_paper_snapshot WHERE doc_id = ?", [doc_id]
        )
    await db.insert_snapshot(
        doc_id=doc_id, version=version, doc_json=doc_json, actor_id=actor_id
    )
    get_registry(ds)._instances.pop(doc_id, None)  # force re-hydrate


@pytest_asyncio.fixture
async def ds_paper():
    """Yield ``(datasette, paper_db)`` with default actor cookie bound."""
    ds, paper = await setup_paper_datasette()
    yield ds, paper


@pytest_asyncio.fixture
async def ds():
    """Yield a Datasette with default actor cookie bound."""
    ds, _ = await setup_paper_datasette()
    yield ds


@pytest_asyncio.fixture
async def ds_with_doc():
    """Yield ``(datasette, paper_db, doc_id)`` for one blank alice-owned doc."""
    ds, paper = await setup_paper_datasette()
    doc_id = await create_doc(ds)
    yield ds, paper, doc_id
