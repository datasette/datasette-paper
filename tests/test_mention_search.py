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

from conftest import (
    actor_cookie,
    build_ds,
    create_doc,
    grant_role,
    setup_paper_datasette,
)


@pytest.mark.asyncio
async def test_mention_search_returns_explicit_grants():
    ds, _ = await setup_paper_datasette()
    # alice owns the doc (seeded Manager grant); add two more explicit viewers.
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob")
    await grant_role(ds, doc_id, "carol")

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
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob")
    await grant_role(ds, doc_id, "carol")

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/mention-search?q=car")
    assert resp.status_code == 200, resp.text
    ids = {r["id"] for r in resp.json()["results"]}
    assert ids == {"carol"}


@pytest.mark.asyncio
async def test_mention_search_open_audience_flag():
    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
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
async def test_mention_search_without_profile_access_degrades(monkeypatch):
    """Name/avatar resolution is gated on ``profile_access`` (mirrors the
    resolve_actors / list_docs siblings).

    A profile source is stubbed in so the gate is observable: the default
    fixture grants paper-create but NOT profile_access, so the viewer names
    degrade to id-as-name with a null avatar — no profile leak.
    """
    import datasette_paper.routes.docs as docs

    async def fake_profiles(datasette, ids):
        return {i: {"name": f"Name {i}", "avatar_url": f"/pic/{i}"} for i in ids}

    monkeypatch.setattr(docs, "resolve_actor_profiles", fake_profiles)

    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob")

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/mention-search")
    assert resp.status_code == 200, resp.text
    by_id = {r["id"]: r for r in resp.json()["results"]}
    # Degraded: id-as-name, no avatar — the stubbed profile never flows through.
    assert by_id["bob"]["name"] == "bob"
    assert by_id["bob"]["avatar_url"] is None


@pytest.mark.asyncio
async def test_mention_search_with_profile_access_resolves(monkeypatch):
    """With ``profile_access`` granted, the stubbed name/avatar flow through."""
    import datasette_paper.routes.docs as docs

    async def fake_profiles(datasette, ids):
        return {i: {"name": f"Name {i}", "avatar_url": f"/pic/{i}"} for i in ids}

    monkeypatch.setattr(docs, "resolve_actor_profiles", fake_profiles)

    ds = await build_ds(
        config={
            "permissions": {
                "datasette-paper-create": True,
                "profile_access": True,
            }
        }
    )
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob")

    resp = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}/mention-search",
        cookies=actor_cookie(ds, "alice"),
    )
    assert resp.status_code == 200, resp.text
    by_id = {r["id"]: r for r in resp.json()["results"]}
    assert by_id["bob"]["name"] == "Name bob"
    assert by_id["bob"]["avatar_url"] == "/pic/bob"


@pytest.mark.asyncio
async def test_mention_search_denied_for_non_viewer():
    ds, _ = await setup_paper_datasette()
    # carol's private doc — alice (the bound fixture actor) cannot view it.
    doc_id = await create_doc(ds, "Carol Private", actor_id="carol")

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/mention-search")
    assert resp.status_code == 403
