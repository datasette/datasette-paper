"""Jump-menu integration: ``/-/jump.json`` surfaces paper docs the actor can view.

datasette-paper implements Datasette's ``jump_items_sql`` hook so docs show up
in the navigation jump menu alongside databases / tables / queries. Items are
permission-filtered through ``allowed_resources_sql("paper-view")`` and limited
to active, non-template docs.
"""

from __future__ import annotations

import pytest

pytest.importorskip("datasette.jump", reason="Datasette without the jump menu")

from conftest import (  # noqa: E402
    actor_cookie,
    create_doc,
    grant_role,
    setup_paper_datasette,
)

pytestmark = pytest.mark.asyncio


async def _paper_matches(ds, q="", cookies=None):
    kwargs = {"cookies": cookies} if cookies else {}
    resp = await ds.client.get(f"/-/jump.json?q={q}", **kwargs)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["ok"] is True
    return [m for m in data["matches"] if m["type"] == "paper"]


# @feat jump-menu: owner's docs appear with a resolved /-/paper/doc/{id} url
async def test_owner_sees_their_doc():
    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Quarterly report")

    matches = await _paper_matches(ds, q="quarterly")
    assert matches == [
        {
            "name": "Quarterly report",
            "url": f"/-/paper/doc/{doc_id}",
            "type": "paper",
            "description": None,
        }
    ]
    # Empty q lists everything, papers included
    assert [m["name"] for m in await _paper_matches(ds)] == ["Quarterly report"]
    # Non-matching q filters it out
    assert await _paper_matches(ds, q="zebra") == []


# @feat jump-menu: items are permission-filtered via paper-view
async def test_stranger_does_not_see_doc_until_granted():
    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Secret plans")

    bob = actor_cookie(ds, "bob")
    assert await _paper_matches(ds, q="secret", cookies=bob) == []

    await grant_role(ds, doc_id, "bob", role="Viewer")
    assert [m["name"] for m in await _paper_matches(ds, q="secret", cookies=bob)] == [
        "Secret plans"
    ]


# @feat jump-menu: archived/trashed docs and templates are excluded
async def test_non_active_and_template_docs_excluded():
    ds, _ = await setup_paper_datasette()
    await create_doc(ds, "Active notes")
    archived = await create_doc(ds, "Archived notes")
    trashed = await create_doc(ds, "Trashed notes")
    await create_doc(ds, "Notes template", kind="template")
    r = await ds.client.post(f"/-/paper/api/docs/{archived}/archive")
    assert r.status_code == 200, r.text
    r = await ds.client.post(f"/-/paper/api/docs/{trashed}/trash")
    assert r.status_code == 200, r.text

    assert [m["name"] for m in await _paper_matches(ds, q="notes")] == ["Active notes"]
