"""Tests for GET /-/paper/api/docs/{doc_id}/mention-search.

View-gated, doc-scoped autocomplete of "users who can view this doc",
sourced from named_viewers + resolve_actor_profiles, filtered by ?q=.
Returns {"results": [{id, name, avatar_url}], "open_audience": bool}.
See routes/docs.py::mention_search.
"""

import pytest

from datasette_acl.grants import grant, Principal
from datasette_paper.permissions import (
    PAPER_DOC_RESOURCE_TYPE,
    PAPER_DOCS_PARENT,
)

from conftest import setup_paper_datasette


async def _create_doc(ds, name, actor_id):
    """Create a doc as ``actor_id`` and return its new id."""
    cookie = ds.sign({"a": {"id": actor_id}}, "actor")
    resp = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": name},
        cookies={"ds_actor": cookie},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _grant_viewer(ds, doc_id, actor_id):
    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.actor(actor_id),
        role="Viewer",
        by_actor="alice",
    )


@pytest.mark.asyncio
async def test_mention_search_returns_explicit_grants():
    ds, _ = await setup_paper_datasette()
    # alice owns the doc (seeded Manager grant); add two more explicit viewers.
    doc_id = await _create_doc(ds, "Doc", "alice")
    await _grant_viewer(ds, doc_id, "bob")
    await _grant_viewer(ds, doc_id, "carol")

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/mention-search")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["open_audience"] is False
    ids = {r["id"] for r in body["results"]}
    assert {"alice", "bob", "carol"} <= ids
    # Names fall back to the id when no profile source is installed.
    by_id = {r["id"]: r for r in body["results"]}
    assert by_id["bob"]["name"] == "bob"
    assert by_id["bob"]["avatar_url"] is None


@pytest.mark.asyncio
async def test_mention_search_q_filters_by_substring():
    ds, _ = await setup_paper_datasette()
    doc_id = await _create_doc(ds, "Doc", "alice")
    await _grant_viewer(ds, doc_id, "bob")
    await _grant_viewer(ds, doc_id, "carol")

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/mention-search?q=car")
    assert resp.status_code == 200, resp.text
    ids = {r["id"] for r in resp.json()["results"]}
    assert ids == {"carol"}


@pytest.mark.asyncio
async def test_mention_search_open_audience_flag():
    ds, _ = await setup_paper_datasette()
    doc_id = await _create_doc(ds, "Doc", "alice")
    # Public-audience viewer: audience can't be enumerated → open_audience.
    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.authenticated(),
        role="Viewer",
        by_actor="alice",
    )

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/mention-search")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["open_audience"] is True
    # Only the named (owner) actor is enumerated; the open audience is not.
    ids = {r["id"] for r in body["results"]}
    assert ids == {"alice"}


@pytest.mark.asyncio
async def test_mention_search_denied_for_non_viewer():
    ds, _ = await setup_paper_datasette()
    # carol's private doc — alice (the bound fixture actor) cannot view it.
    doc_id = await _create_doc(ds, "Carol Private", "carol")

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/mention-search")
    assert resp.status_code == 403
