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

import pytest_asyncio
from datasette.app import Datasette

from datasette_paper.db import PaperDB


DEFAULT_ACTOR_ID = "alice"


def make_datasette(*, granted: bool = True) -> Datasette:
    """Construct an in-memory Datasette with the paper permissions flagged.

    *granted=True* grants ``datasette-paper-list`` + ``datasette-paper-create``
    to everyone (matching the dev / e2e setup). Per-paper ``view`` / ``edit`` /
    ``manage`` are resolved by datasette-acl grants on the ``paper-doc``
    resource (the owner gets a Manager grant seeded on create).

    *granted=False* leaves all paper permissions unset.
    """
    config = (
        {
            "permissions": {
                "datasette-paper-list": True,
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
