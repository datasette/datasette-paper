"""Tests for the header-bar breadcrumb.

@feat breadcrumbs: proves the crumbs block renders "[icon] Papers" on every
paper page, the current-page segment on doc/tag pages (escaped), and that a
rename broadcasts a ``renamed`` SSE event to live subscribers.
"""

import asyncio

import pytest

from datasette_paper.instance import get_registry


@pytest.mark.asyncio
async def test_index_crumb_is_papers_only(ds):
    html = (await ds.client.get("/-/paper/")).text
    assert 'class="crumbs paper-crumbs"' in html
    assert "<span>Papers</span>" in html
    # The icon rides along inside the link (bootstrap file-text-fill).
    assert "bi-file-text-fill" in html
    # No current-page segment on the index, and Datasette's default "home"
    # crumb is replaced, not prepended.
    assert "paper-crumb-current" not in html
    assert ">home</a>" not in html


@pytest.mark.asyncio
async def test_doc_crumb_shows_doc_name(ds):
    doc_id = (
        await ds.client.post("/-/paper/api/docs", json={"name": "Quarterly Notes"})
    ).json()["id"]
    html = (await ds.client.get(f"/-/paper/doc/{doc_id}")).text
    assert 'class="crumbs paper-crumbs"' in html
    assert '<span id="paper-crumb-current">Quarterly Notes</span>' in html


@pytest.mark.asyncio
async def test_doc_crumb_escapes_name(ds):
    doc_id = (
        await ds.client.post(
            "/-/paper/api/docs", json={"name": "<script>alert(1)</script>"}
        )
    ).json()["id"]
    html = (await ds.client.get(f"/-/paper/doc/{doc_id}")).text
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html


@pytest.mark.asyncio
async def test_tag_crumb_shows_tag(ds):
    html = (await ds.client.get("/-/paper/tag/standup")).text
    assert '<span id="paper-crumb-current">#standup</span>' in html


@pytest.mark.asyncio
async def test_rename_broadcasts_renamed(ds):
    """Renaming a doc with a live subscriber pushes a ``renamed`` event."""
    from datasette_paper.db import PaperDB

    doc_id = (await ds.client.post("/-/paper/api/docs", json={"name": "Old"})).json()[
        "id"
    ]
    db = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    instance = await registry.get(db, doc_id)
    queue = await instance.subscribe(client_id=42, actor_id="alice")

    r = await ds.client.post(f"/-/paper/api/docs/{doc_id}/rename", json={"name": "New"})
    assert r.status_code == 200

    payload = await asyncio.wait_for(queue.get(), timeout=1)
    assert payload["kind"] == "renamed"
    assert payload["name"] == "New"
    assert payload["updated_at"]


@pytest.mark.asyncio
async def test_rename_without_hot_instance_is_fine(ds):
    """No live Instance for the doc → rename succeeds, no broadcast attempted."""
    doc_id = (await ds.client.post("/-/paper/api/docs", json={"name": "A"})).json()[
        "id"
    ]
    r = await ds.client.post(f"/-/paper/api/docs/{doc_id}/rename", json={"name": "B"})
    assert r.status_code == 200
    assert r.json()["name"] == "B"
