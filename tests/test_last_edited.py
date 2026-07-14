"""Tests for the "edited Xm ago by Y" indicator's backend surfaces.

@feat last-edited-indicator: last-editor attribution — the
``latestEditorForDocs`` read over the doc-activity rollup feeding
``last_edited_by*`` on the listing, and the ``lastActor``/``lastEditedAt``
ride-along on SSE update payloads. The rollup write side is covered in
test_doc_activity.py; the header/listing render + live wiring in the
frontend suites.
"""

import asyncio

import pytest
from datasette.app import Datasette

from datasette_paper.db import PaperDB
from datasette_paper.instance import Instance
from datasette_paper.migrations import ensure_migrations

from _steps import insert_at  # noqa: E402  (sibling helper)
from conftest import actor_cookie, build_ds


async def make_paper_db() -> tuple[Datasette, PaperDB]:
    ds = Datasette(memory=True)
    internal = ds.get_internal_database()
    await ensure_migrations(internal)
    return ds, PaperDB(internal)


@pytest.mark.asyncio
async def test_latest_editor_for_docs_picks_max_per_doc():
    """Two actors on one doc → the later editor wins; docs with no rollup
    rows are absent from the map entirely."""
    _, paper = await make_paper_db()
    doc = await paper.insert_doc(name="Shared", created_by="alice")
    untouched = await paper.insert_doc(name="Untouched", created_by="alice")

    await paper.insert_step(
        doc_id=doc.id, client_id=1, actor_id="alice", step_json="{}"
    )
    # Stamps are SQL-side with millisecond precision; 2ms guarantees bob's
    # edit lands strictly later.
    await asyncio.sleep(0.002)
    await paper.insert_step(doc_id=doc.id, client_id=2, actor_id="bob", step_json="{}")

    editors = await paper.latest_editor_for_docs(doc_ids=[doc.id, untouched.id])
    assert set(editors) == {doc.id}
    assert editors[doc.id].actor_id == "bob"
    assert editors[doc.id].last_edited_at is not None


@pytest.mark.asyncio
async def test_list_docs_carries_last_edited_by(ds_paper):
    """The listing exposes the rollup's latest editor; without a profile
    source the name falls back to the raw id, and a doc with no rollup rows
    reports null for both fields."""
    ds, paper = ds_paper
    edited = (await ds.client.post("/-/paper/api/docs", json={"name": "Edited"})).json()
    await ds.client.post("/-/paper/api/docs", json={"name": "Fresh"})
    await paper.insert_step(
        doc_id=edited["id"], client_id=1, actor_id="bob", step_json="{}"
    )

    docs = {d["name"]: d for d in (await ds.client.get("/-/paper/api/docs")).json()}
    assert docs["Edited"]["last_edited_by"] == "bob"
    assert docs["Edited"]["last_edited_by_name"] == "bob"
    assert docs["Fresh"]["last_edited_by"] is None
    assert docs["Fresh"]["last_edited_by_name"] is None


@pytest.mark.asyncio
async def test_list_docs_anonymous_edit_keeps_last_attribution(ds_paper):
    """An anonymous step bumps updated_at but never attributes: the listing
    keeps showing the last attributed editor."""
    ds, paper = ds_paper
    doc = (await ds.client.post("/-/paper/api/docs", json={"name": "Doc"})).json()
    await paper.insert_step(
        doc_id=doc["id"], client_id=1, actor_id="alice", step_json="{}"
    )
    before = (await ds.client.get("/-/paper/api/docs")).json()[0]

    await asyncio.sleep(0.002)
    await paper.insert_step(
        doc_id=doc["id"], client_id=2, actor_id=None, step_json="{}"
    )

    after = (await ds.client.get("/-/paper/api/docs")).json()[0]
    assert after["updated_at"] > before["updated_at"]
    assert after["last_edited_by"] == "alice"


@pytest.mark.asyncio
async def test_list_docs_last_editor_resolves_profile(monkeypatch):
    """With profile_access granted, last_edited_by_name resolves through the
    same batch as the creator fields."""
    ds = await build_ds(
        config={"permissions": {"datasette-paper-create": True, "profile_access": True}}
    )
    cookies = actor_cookie(ds, "alice")
    doc = (
        await ds.client.post(
            "/-/paper/api/docs", json={"name": "Mine"}, cookies=cookies
        )
    ).json()
    paper = PaperDB(ds.get_internal_database())
    await paper.insert_step(
        doc_id=doc["id"], client_id=1, actor_id="bob", step_json="{}"
    )

    async def fake_actors_from_ids(actor_ids):
        return {
            aid: {"id": aid, "display_name": aid.title() + "!"} for aid in actor_ids
        }

    monkeypatch.setattr(ds, "actors_from_ids", fake_actors_from_ids)
    docs = (await ds.client.get("/-/paper/api/docs", cookies=cookies)).json()
    assert docs[0]["created_by_name"] == "Alice!"
    assert docs[0]["last_edited_by"] == "bob"
    assert docs[0]["last_edited_by_name"] == "Bob!"


@pytest.mark.asyncio
async def test_broadcast_payload_carries_attribution():
    """The SSE update payload rides lastActor + lastEditedAt along with the
    step batch — the live header updates without a refetch. Anonymous
    batches ride a null actor."""
    _, paper = await make_paper_db()
    doc = await paper.insert_doc(name="Live", created_by="alice")
    inst = await Instance.hydrate(paper, doc.id)
    q = await inst.subscribe(client_id=99)

    await inst.add_events(
        version=inst.version, client_id=1, actor_id="bob", steps=[insert_at(1)]
    )
    payload = await asyncio.wait_for(q.get(), timeout=1)
    assert payload["kind"] == "update"
    assert payload["lastActor"] == "bob"
    assert payload["lastEditedAt"] is not None

    await inst.add_events(
        version=inst.version, client_id=1, actor_id=None, steps=[insert_at(1)]
    )
    payload = await asyncio.wait_for(q.get(), timeout=1)
    assert payload["lastActor"] is None
    assert payload["lastEditedAt"] is not None


@pytest.mark.asyncio
async def test_get_events_catchup_carries_attribution():
    """The catch-up path (get_events) rides the same attribution as the live
    broadcast — the slice's last step's actor and stamp."""
    _, paper = await make_paper_db()
    doc = await paper.insert_doc(name="Catchup", created_by="alice")
    inst = await Instance.hydrate(paper, doc.id)

    await inst.add_events(
        version=inst.version, client_id=1, actor_id="alice", steps=[insert_at(1)]
    )
    await inst.add_events(
        version=inst.version, client_id=1, actor_id="bob", steps=[insert_at(1)]
    )

    payload = inst.get_events(0)
    assert payload["lastActor"] == "bob"
    assert payload["lastEditedAt"] is not None
