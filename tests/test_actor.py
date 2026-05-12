"""Actor capture + UI-surface tests for datasette-paper.

Covers:
- created_by on _datasette_paper_doc (POST /api/docs)
- actor_id on _datasette_paper_step (POST /events)
- actor_id on _datasette_paper_snapshot (POST /api/docs/:id/snapshot)
- the "Papers" link rendered by the menu_links hook
- the `users` field in the bootstrap envelope tracking subscriber count
"""

import asyncio

import pytest

from datasette_paper.instance import get_registry


def _alice_cookie(ds):
    """Signed actor cookie for `alice`."""
    return {"ds_actor": ds.sign({"a": {"id": "alice"}}, "actor")}


# ---------------------------------------------------------------------------
# Doc creation records the actor
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_doc_records_actor(ds_paper):
    ds, paper_db = ds_paper
    resp = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Alice Paper"},
        cookies=_alice_cookie(ds),
    )
    assert resp.status_code == 201
    doc = resp.json()
    assert doc["created_by"] == "alice"

    row = await paper_db.select_doc_by_id(doc["id"])
    assert row.created_by == "alice"


@pytest.mark.asyncio
async def test_create_doc_anonymous_has_null_created_by():
    """Paper created without an actor cookie has created_by = NULL."""
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
    resp = await ds.client.post("/-/paper/api/docs", json={"name": "Anon Paper"})
    assert resp.status_code == 201
    assert resp.json()["created_by"] is None


# ---------------------------------------------------------------------------
# Steps record the actor
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_step_records_actor(ds_paper):
    ds, paper_db = ds_paper
    cookies = _alice_cookie(ds)

    create = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Steps Paper"},
        cookies=cookies,
    )
    doc_id = create.json()["id"]

    step_resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/events",
        json={
            "version": 0,
            "clientID": 42,
            "steps": [{"stepType": "replace", "from": 1, "to": 1}],
            "comment": [],
        },
        cookies=cookies,
    )
    assert step_resp.status_code == 200

    rows = await paper_db.database.execute(
        "SELECT actor_id FROM _datasette_paper_step WHERE doc_id = ? ORDER BY version",
        [doc_id],
    )
    actor_ids = [r["actor_id"] for r in rows]
    assert actor_ids == ["alice"]


# ---------------------------------------------------------------------------
# Snapshots record the actor
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_snapshot_records_actor(ds_paper):
    from _steps import insert_at  # noqa: E402  (sibling helper)

    ds, paper_db = ds_paper
    cookies = _alice_cookie(ds)

    create = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Snap Paper"},
        cookies=cookies,
    )
    doc_id = create.json()["id"]

    # Drive the doc past the snapshot threshold via real steps so the
    # server can materialize when /snapshot fires (the endpoint refuses
    # to write a snapshot when materialization is poisoned).
    events_url = f"/-/paper/api/docs/{doc_id}/events"
    for i in range(100):
        resp = await ds.client.post(
            events_url,
            json={"version": i, "clientID": 1, "steps": [insert_at(1, "x")]},
            cookies=cookies,
        )
        assert resp.status_code == 200

    snap_resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/snapshot",
        json={},
        cookies=cookies,
    )
    assert snap_resp.status_code == 200

    rows = await paper_db.database.execute(
        "SELECT actor_id, version FROM _datasette_paper_snapshot WHERE doc_id = ?",
        [doc_id],
    )
    captured = [(r["actor_id"], r["version"]) for r in rows]
    assert captured == [("alice", 100)]


# ---------------------------------------------------------------------------
# menu_links surfaces the link
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_menu_links_link_present(ds):
    """For an actor with permission, the top-level menu lists the Papers link."""
    resp = await ds.client.get("/", cookies=_alice_cookie(ds))
    assert resp.status_code == 200
    body = resp.text
    assert "/-/paper/" in body
    assert "Papers" in body


@pytest.mark.asyncio
async def test_menu_links_link_absent_for_denied_actor():
    """Without permission, the Papers link is not rendered."""
    from datasette.app import Datasette

    ds = Datasette(memory=True, config={})
    await ds.invoke_startup()
    resp = await ds.client.get("/")
    assert resp.status_code == 200
    # The link must not surface for anonymous users without permission.
    assert ">Papers<" not in resp.text


# ---------------------------------------------------------------------------
# Bootstrap envelope users field
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_users_count_reflects_subscribers(ds_paper):
    ds, paper_db = ds_paper

    create = await ds.client.post("/-/paper/api/docs", json={"name": "Users Paper"})
    doc_id = create.json()["id"]

    registry = get_registry(ds)
    instance = await registry.get(paper_db, doc_id)
    q1 = await instance.subscribe(client_id=111)
    q2 = await instance.subscribe(client_id=222)

    boot = await ds.client.get(f"/-/paper/api/docs/{doc_id}")
    assert boot.status_code == 200
    assert boot.json()["users"] == 2

    instance.unsubscribe(q1)
    instance.unsubscribe(q2)
    boot2 = await ds.client.get(f"/-/paper/api/docs/{doc_id}")
    assert boot2.json()["users"] == 0

    _ = (q1, q2)
    await asyncio.sleep(0)
