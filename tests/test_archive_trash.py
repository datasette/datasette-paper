"""Tests for archive / trash state transitions and the cron sweep.

Coverage:

- Each route flips ``state`` + the right timestamps, including
  ``delete_at = trashed_at + 7d`` math.
- The list endpoint filters by ``?state=`` (default ``active``).
- Owner-only enforcement: an editor share gets 403.
- ``state-changed`` is broadcast to live SSE subscribers.
- ``cron.sweep_trashed`` hard-deletes past-due rows and cascades.
- The doc-page bootstrap envelope carries the state fields.
"""

from __future__ import annotations

import asyncio
import datetime
import json

import pytest

from datasette_paper.cron import sweep_trashed
from datasette_paper.instance import get_registry


def _parse_iso(s: str) -> datetime.datetime:
    """Parse the ISO-8601 form the schema's strftime emits.

    Python's ``fromisoformat`` accepts the trailing ``Z`` from 3.11+; we
    normalize to ``+00:00`` for compatibility regardless.
    """
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# Listing + state transitions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_default_excludes_archived_and_trashed(ds):
    a = (await ds.client.post("/-/paper/api/docs", json={"name": "A"})).json()["id"]
    b = (await ds.client.post("/-/paper/api/docs", json={"name": "B"})).json()["id"]
    c = (await ds.client.post("/-/paper/api/docs", json={"name": "C"})).json()["id"]

    assert (await ds.client.post(f"/-/paper/api/docs/{b}/archive")).status_code == 200
    assert (await ds.client.post(f"/-/paper/api/docs/{c}/trash")).status_code == 200

    # Default list = active only.
    rows = (await ds.client.get("/-/paper/api/docs")).json()
    assert {r["id"] for r in rows} == {a}
    assert rows[0]["state"] == "active"
    assert rows[0]["archived_at"] is None
    assert rows[0]["trashed_at"] is None
    assert rows[0]["delete_at"] is None

    # Archive tab.
    rows = (await ds.client.get("/-/paper/api/docs?state=archived")).json()
    assert {r["id"] for r in rows} == {b}
    assert rows[0]["state"] == "archived"
    assert rows[0]["archived_at"] is not None

    # Trash tab.
    rows = (await ds.client.get("/-/paper/api/docs?state=trashed")).json()
    assert {r["id"] for r in rows} == {c}
    assert rows[0]["state"] == "trashed"
    assert rows[0]["trashed_at"] is not None
    assert rows[0]["delete_at"] is not None


@pytest.mark.asyncio
async def test_list_rejects_invalid_state(ds):
    r = await ds.client.get("/-/paper/api/docs?state=banana")
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_archive_then_unarchive_round_trip(ds):
    doc_id = (await ds.client.post("/-/paper/api/docs", json={"name": "X"})).json()[
        "id"
    ]

    r = await ds.client.post(f"/-/paper/api/docs/{doc_id}/archive")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "archived"
    assert body["archived_at"] is not None
    assert body["trashed_at"] is None
    assert body["delete_at"] is None

    r = await ds.client.post(f"/-/paper/api/docs/{doc_id}/unarchive")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "active"
    assert body["archived_at"] is None


@pytest.mark.asyncio
async def test_trash_sets_delete_at_seven_days_from_trashed_at(ds):
    doc_id = (await ds.client.post("/-/paper/api/docs", json={"name": "X"})).json()[
        "id"
    ]
    before = datetime.datetime.now(datetime.timezone.utc)
    body = (await ds.client.post(f"/-/paper/api/docs/{doc_id}/trash")).json()
    after = datetime.datetime.now(datetime.timezone.utc)

    assert body["state"] == "trashed"
    trashed_at = _parse_iso(body["trashed_at"])
    delete_at = _parse_iso(body["delete_at"])
    # trashed_at lands within the request window.
    assert before - datetime.timedelta(seconds=1) <= trashed_at
    assert trashed_at <= after + datetime.timedelta(seconds=1)
    # delete_at is exactly 7 days after the request fired (the route
    # writes both at the same instant; allow a small slack for clock
    # granularity vs strftime's millisecond rounding).
    assert abs(
        (delete_at - trashed_at) - datetime.timedelta(days=7)
    ) < datetime.timedelta(seconds=2)


@pytest.mark.asyncio
async def test_restore_from_trash_clears_timestamps(ds):
    doc_id = (await ds.client.post("/-/paper/api/docs", json={"name": "X"})).json()[
        "id"
    ]
    await ds.client.post(f"/-/paper/api/docs/{doc_id}/trash")
    body = (await ds.client.post(f"/-/paper/api/docs/{doc_id}/restore")).json()
    assert body["state"] == "active"
    assert body["archived_at"] is None
    assert body["trashed_at"] is None
    assert body["delete_at"] is None


# ---------------------------------------------------------------------------
# Owner-only enforcement
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_editor_share_cannot_archive_or_trash():
    """Edit permission alone isn't enough — manage is owner-only."""
    from datasette.app import Datasette

    ds = Datasette(
        memory=True,
        config={
            "permissions": {
                "datasette-paper-list": True,
                "datasette-paper-create": True,
            }
        },
    )
    await ds.invoke_startup()

    alice = {"ds_actor": ds.sign({"a": {"id": "alice"}}, "actor")}
    bob = {"ds_actor": ds.sign({"a": {"id": "bob"}}, "actor")}

    create = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Shared"}, cookies=alice
    )
    doc_id = create.json()["id"]

    # Hand-grant bob the editor role via acl.
    from datasette_acl.grants import grant
    from datasette_paper.permissions import (
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
    )

    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        actor_id="bob",
        role="Editor",
        by_actor="alice",
    )

    # Bob can edit (existing behavior) but neither archive nor trash.
    for path in ("/archive", "/trash"):
        r = await ds.client.post(f"/-/paper/api/docs/{doc_id}{path}", cookies=bob)
        assert r.status_code == 403, f"{path} should be 403 for editor"


# ---------------------------------------------------------------------------
# Bootstrap envelope
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bootstrap_envelope_carries_state(ds):
    doc_id = (await ds.client.post("/-/paper/api/docs", json={"name": "X"})).json()[
        "id"
    ]
    boot = (await ds.client.get(f"/-/paper/api/docs/{doc_id}")).json()
    assert boot["state"] == "active"
    assert boot["archived_at"] is None
    assert boot["trashed_at"] is None
    assert boot["delete_at"] is None

    await ds.client.post(f"/-/paper/api/docs/{doc_id}/archive")
    boot = (await ds.client.get(f"/-/paper/api/docs/{doc_id}")).json()
    assert boot["state"] == "archived"
    assert boot["archived_at"] is not None


# ---------------------------------------------------------------------------
# state-changed broadcast
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_state_changed_broadcast_to_subscribers(ds):
    """Trashing a doc with a live subscriber pushes ``state-changed``."""
    from datasette_paper.db import PaperDB

    doc_id = (await ds.client.post("/-/paper/api/docs", json={"name": "X"})).json()[
        "id"
    ]
    db = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    instance = await registry.get(db, doc_id)
    queue = await instance.subscribe(client_id=42, actor_id="alice")

    r = await ds.client.post(f"/-/paper/api/docs/{doc_id}/trash")
    assert r.status_code == 200

    payload = await asyncio.wait_for(queue.get(), timeout=1)
    assert payload["kind"] == "state-changed"
    assert payload["state"] == "trashed"
    assert payload["trashed_at"] is not None
    assert payload["delete_at"] is not None


# ---------------------------------------------------------------------------
# Cron sweep
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sweep_trashed_deletes_past_due_and_cascades(ds_paper):
    """delete_at < now → row + steps + snapshots cascade away.

    (Sharing moved to acl, so there is no ``_datasette_paper_share`` table to
    cascade anymore — the hard delete only spans the doc + its step/snapshot
    history.)
    """
    ds, db = ds_paper
    create = await ds.client.post("/-/paper/api/docs", json={"name": "Sweep"})
    doc_id = create.json()["id"]

    # Plant a snapshot so cascade has something to remove.
    await db.insert_snapshot(
        doc_id=doc_id, version=0, doc_json=json.dumps({"type": "doc"}), actor_id=None
    )

    # Trash with a backdated delete_at so the sweep picks it up.
    past = "2000-01-01T00:00:00.000Z"
    await ds.get_internal_database().execute_write(
        "UPDATE _datasette_paper_doc "
        "SET state='trashed', trashed_at=?, delete_at=? WHERE id=?",
        [past, past, doc_id],
    )

    swept = await sweep_trashed(ds)
    assert swept == 1

    # Doc gone, cascades cleared.
    internal = ds.get_internal_database()
    rows = await internal.execute(
        "SELECT COUNT(*) FROM _datasette_paper_doc WHERE id = ?", [doc_id]
    )
    assert rows.first()[0] == 0
    rows = await internal.execute(
        "SELECT COUNT(*) FROM _datasette_paper_snapshot WHERE doc_id = ?", [doc_id]
    )
    assert rows.first()[0] == 0


@pytest.mark.asyncio
async def test_sweep_trashed_skips_future_delete_at(ds):
    """A doc trashed today is NOT swept (delete_at is in the future)."""
    doc_id = (await ds.client.post("/-/paper/api/docs", json={"name": "X"})).json()[
        "id"
    ]
    await ds.client.post(f"/-/paper/api/docs/{doc_id}/trash")
    swept = await sweep_trashed(ds)
    assert swept == 0
    # Doc still present in the trash listing.
    rows = (await ds.client.get("/-/paper/api/docs?state=trashed")).json()
    assert any(r["id"] == doc_id for r in rows)


@pytest.mark.asyncio
async def test_sweep_trashed_kicks_subscribers_and_evicts_instance(ds):
    """Hot Instance is evicted; open subscribers receive the closed sentinel."""
    from datasette_paper.db import PaperDB

    doc_id = (await ds.client.post("/-/paper/api/docs", json={"name": "X"})).json()[
        "id"
    ]
    db = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    instance = await registry.get(db, doc_id)
    queue = await instance.subscribe(client_id=1, actor_id="alice")

    past = "2000-01-01T00:00:00.000Z"
    await ds.get_internal_database().execute_write(
        "UPDATE _datasette_paper_doc "
        "SET state='trashed', trashed_at=?, delete_at=? WHERE id=?",
        [past, past, doc_id],
    )

    swept = await sweep_trashed(ds)
    assert swept == 1
    assert doc_id not in registry._instances

    payload = await asyncio.wait_for(queue.get(), timeout=1)
    assert payload == {"kind": "closed"}
