"""Tests for the datasette-paper document API routes."""

import json

import pytest

from conftest import plant_snapshot


@pytest.mark.asyncio
async def test_create_doc_then_list(ds):
    # POST to create
    response = await ds.client.post("/-/paper/api/docs", json={"name": "My Paper"})
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "My Paper"
    assert body["id"] is not None

    # GET list
    response = await ds.client.get("/-/paper/api/docs")
    assert response.status_code == 200
    docs = response.json()
    assert len(docs) == 1
    assert docs[0]["name"] == "My Paper"
    # The list includes per-row is_owner (sharing itself is now acl-owned, so
    # there is no per-doc visibility enum on the row anymore).
    assert docs[0]["is_owner"] is True


@pytest.mark.asyncio
async def test_list_created_by_name_falls_back_to_id(ds):
    """Without a profile source, created_by_name is the id and avatar is None."""
    await ds.client.post("/-/paper/api/docs", json={"name": "Mine"})
    docs = (await ds.client.get("/-/paper/api/docs")).json()
    assert docs[0]["created_by"] == "alice"
    assert docs[0]["created_by_name"] == "alice"
    assert docs[0]["created_by_avatar"] is None


@pytest.mark.asyncio
async def test_list_created_by_uses_actor_profile(ds, monkeypatch):
    """created_by_name + created_by_avatar resolve through actors_from_ids."""
    await ds.client.post("/-/paper/api/docs", json={"name": "Mine"})

    async def fake_actors_from_ids(actor_ids):
        return {
            aid: {
                "id": aid,
                "display_name": "Alice Liddell",
                "avatar_url": f"/-/profile/pic/{aid}",
            }
            for aid in actor_ids
        }

    monkeypatch.setattr(ds, "actors_from_ids", fake_actors_from_ids)
    docs = (await ds.client.get("/-/paper/api/docs")).json()
    assert docs[0]["created_by"] == "alice"
    assert docs[0]["created_by_name"] == "Alice Liddell"
    assert docs[0]["created_by_avatar"] == "/-/profile/pic/alice"


@pytest.mark.asyncio
async def test_list_created_by_uses_user_profiles(ds):
    """End-to-end: a seeded datasette-user-profiles row surfaces name + avatar.

    Exercises the real plugin path (no monkeypatch) — resolve_profile_actors is
    queried directly because user-profiles doesn't register actors_from_ids.
    """
    await ds.client.post("/-/paper/api/docs", json={"name": "Mine"})
    internal = ds.get_internal_database()
    await internal.execute_write(
        "INSERT INTO datasette_user_profiles (actor_id, display_name) VALUES (?, ?)",
        ["alice", "Alice Anderson"],
    )
    docs = (await ds.client.get("/-/paper/api/docs")).json()
    assert docs[0]["created_by_name"] == "Alice Anderson"
    assert docs[0]["created_by_avatar"] == "/-/profile/pic/alice"


@pytest.mark.asyncio
async def test_list_filters_to_actor_visible_papers():
    """Alice's papers should not appear in Bob's list."""
    from datasette.app import Datasette

    ds = Datasette(
        memory=True,
        config={
            "permissions": {
                "datasette-paper-create": True,
            }
        },
    )
    await ds.invoke_startup()

    alice_cookies = {"ds_actor": ds.sign({"a": {"id": "alice"}}, "actor")}
    bob_cookies = {"ds_actor": ds.sign({"a": {"id": "bob"}}, "actor")}

    await ds.client.post(
        "/-/paper/api/docs", json={"name": "Alice Doc"}, cookies=alice_cookies
    )

    # Alice sees her doc.
    r = await ds.client.get("/-/paper/api/docs", cookies=alice_cookies)
    assert {d["name"] for d in r.json()} == {"Alice Doc"}

    # Bob sees nothing — alice's doc is private.
    r = await ds.client.get("/-/paper/api/docs", cookies=bob_cookies)
    assert r.json() == []


@pytest.mark.asyncio
async def test_bootstrap_includes_permissions_block(ds):
    """Owner gets canEdit=True, canManage=True, isOwner=True."""
    create = await ds.client.post("/-/paper/api/docs", json={"name": "Perms"})
    doc_id = create.json()["id"]

    boot = await ds.client.get(f"/-/paper/api/docs/{doc_id}")
    perms = boot.json()["permissions"]
    assert perms == {
        "canView": True,
        "canEdit": True,
        "canManage": True,
        "isOwner": True,
        "locked": False,
    }


@pytest.mark.asyncio
async def test_bootstrap_permissions_for_shared_viewer():
    """Bob (viewer) sees canEdit=False, canManage=False, isOwner=False."""
    from datasette.app import Datasette

    ds = Datasette(
        memory=True,
        config={
            "permissions": {
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

    # Hand-grant bob the viewer role via an acl grant.
    from datasette_acl.grants import grant, Principal
    from datasette_paper.permissions import (
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
    )

    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.actor("bob"),
        role="Viewer",
        by_actor="alice",
    )

    boot = await ds.client.get(f"/-/paper/api/docs/{doc_id}", cookies=bob)
    perms = boot.json()["permissions"]
    assert perms["canEdit"] is False
    assert perms["canManage"] is False
    assert perms["isOwner"] is False
    assert "visibility" not in perms


@pytest.mark.asyncio
async def test_bootstrap_empty_doc(ds):
    create_resp = await ds.client.post("/-/paper/api/docs", json={"name": "Test Paper"})
    assert create_resp.status_code == 201
    doc_id = create_resp.json()["id"]

    response = await ds.client.get(f"/-/paper/api/docs/{doc_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["version"] == 0
    assert data["snapshotVersion"] == 0
    assert data["steps"] == []
    assert data["clientIDs"] == []
    assert data["doc"]["type"] == "doc"


@pytest.mark.asyncio
async def test_bootstrap_with_steps(ds_paper):
    ds, paper_db = ds_paper

    create_resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Stepped Paper"}
    )
    assert create_resp.status_code == 201
    doc_id = create_resp.json()["id"]

    step_data = json.dumps({"stepType": "replace", "from": 1, "to": 1, "slice": {}})
    for i in range(3):
        await paper_db.insert_step(
            doc_id=doc_id,
            client_id=100 + i,
            step_json=step_data,
        )

    # Evict from registry cache so hydrate re-reads DB
    from datasette_paper.instance import get_registry

    registry = get_registry(ds)
    registry._instances.pop(doc_id, None)

    response = await ds.client.get(f"/-/paper/api/docs/{doc_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["version"] == 3
    assert len(data["steps"]) == 3
    assert len(data["clientIDs"]) == 3


@pytest.mark.asyncio
async def test_bootstrap_with_snapshot(ds_paper):
    ds, paper_db = ds_paper

    create_resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Snapshot Paper"}
    )
    assert create_resp.status_code == 201
    doc_id = create_resp.json()["id"]

    step_data = json.dumps({"stepType": "replace", "from": 1, "to": 1, "slice": {}})
    for i in range(2):
        await paper_db.insert_step(
            doc_id=doc_id,
            client_id=200 + i,
            step_json=step_data,
        )

    snapshot_doc = json.dumps({"type": "doc", "content": [{"type": "paragraph"}]})
    await paper_db.insert_snapshot(doc_id=doc_id, version=2, doc_json=snapshot_doc)

    for i in range(2):
        await paper_db.insert_step(
            doc_id=doc_id,
            client_id=300 + i,
            step_json=step_data,
        )

    from datasette_paper.instance import get_registry

    registry = get_registry(ds)
    registry._instances.pop(doc_id, None)

    response = await ds.client.get(f"/-/paper/api/docs/{doc_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["snapshotVersion"] == 2
    assert data["version"] == 4
    assert len(data["steps"]) == 2
    assert len(data["clientIDs"]) == 2


@pytest.mark.asyncio
async def test_snapshot_endpoint_writes_row(ds_paper):
    """POST /snapshot is a server-side trigger — body is ignored, the
    server materializes its own doc at instance.version and writes that.
    """
    ds, paper_db = ds_paper

    create_resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Snap Write Paper"}
    )
    assert create_resp.status_code == 201
    doc_id = create_resp.json()["id"]

    # Drive the doc to version 100 via the events endpoint so step
    # versions, doc.current_version, and the in-memory Instance all stay
    # coherent (raw paper_db.insert_step bypasses the version bump).
    events_url = f"/-/paper/api/docs/{doc_id}/events"
    from _steps import insert_at  # noqa: E402  (sibling helper)

    for i in range(100):
        resp = await ds.client.post(
            events_url,
            json={"version": i, "clientID": 400, "steps": [insert_at(1, "x")]},
        )
        assert resp.status_code == 200

    response = await ds.client.post(f"/-/paper/api/docs/{doc_id}/snapshot", json={})
    assert response.status_code == 200
    assert response.json() == {"version": 100}

    snapshot = await paper_db.select_latest_snapshot(doc_id=doc_id)
    assert snapshot is not None
    assert snapshot.version == 100


@pytest.mark.asyncio
async def test_snapshot_endpoint_below_threshold_no_write(ds_paper):
    """When version - last_snapshot < SNAPSHOT_THRESHOLD, no new row is
    written. The 200 response still reports the current snapshot version
    so the client can refresh its threshold baseline."""
    ds, paper_db = ds_paper

    create_resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Below Threshold"}
    )
    doc_id = create_resp.json()["id"]

    response = await ds.client.post(f"/-/paper/api/docs/{doc_id}/snapshot", json={})
    assert response.status_code == 200
    assert response.json() == {"version": 0}
    assert await paper_db.select_latest_snapshot(doc_id=doc_id) is None


@pytest.mark.asyncio
async def test_snapshot_does_not_corrupt_subsequent_materialization(ds_paper):
    """Regression: after a snapshot lands, the next materialization
    must apply only steps *after* the new snapshot — not re-apply the
    ones that are already baked into snapshot_doc_json. Re-applying
    them on top of the new base used to fail partway with errors like
    'Structure gap-replace would overwrite content' on the first step
    whose position math didn't line up against the post-snapshot doc.
    """
    from datasette_paper.instance import get_registry
    from _steps import insert_at  # noqa: E402

    ds, paper_db = ds_paper
    create_resp = await ds.client.post("/-/paper/api/docs", json={"name": "Trim Tail"})
    doc_id = create_resp.json()["id"]

    events_url = f"/-/paper/api/docs/{doc_id}/events"
    for i in range(100):
        resp = await ds.client.post(
            events_url,
            json={"version": i, "clientID": 1, "steps": [insert_at(1, "a")]},
        )
        assert resp.status_code == 200

    snap_resp = await ds.client.post(f"/-/paper/api/docs/{doc_id}/snapshot", json={})
    assert snap_resp.status_code == 200

    # One more step after the snapshot, then re-materialize. If the tail
    # wasn't trimmed, materialize would replay all 100 pre-snapshot
    # steps on top of the post-snapshot doc and trip a content-spec
    # violation before reaching the new step.
    resp = await ds.client.post(
        events_url,
        json={"version": 100, "clientID": 1, "steps": [insert_at(1, "b")]},
    )
    assert resp.status_code == 200

    instance = await get_registry(ds).get(paper_db, doc_id)
    instance._cached_live_doc_json = None
    instance._cached_live_version = None
    instance.materialize_live_doc()
    assert instance._materialization_error is None


@pytest.mark.asyncio
async def test_403_on_unknown_doc(ds):
    """Resource-level permissions don't leak existence: missing doc → 403, not 404.

    The permission_resources_sql hook only emits rows for docs the actor
    can access. A non-existent doc has no rows → default deny → Forbidden.
    """
    response = await ds.client.get("/-/paper/api/docs/99999")
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_rename_doc(ds):
    create = await ds.client.post("/-/paper/api/docs", json={"name": "Old Name"})
    assert create.status_code == 201
    doc_id = create.json()["id"]

    rename = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/rename",
        json={"name": "New Name"},
    )
    assert rename.status_code == 200
    assert rename.json()["name"] == "New Name"

    listing = await ds.client.get("/-/paper/api/docs")
    names = {d["name"] for d in listing.json()}
    assert "New Name" in names
    assert "Old Name" not in names


@pytest.mark.asyncio
async def test_rename_doc_unknown_403(ds):
    """Per-doc edit permissions deny unknown docs at the gate (not 404)."""
    await ds.client.post("/-/paper/api/docs", json={"name": "X"})
    resp = await ds.client.post(
        "/-/paper/api/docs/99999/rename",
        json={"name": "anything"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_get_document_json_envelope(ds):
    create = await ds.client.post("/-/paper/api/docs", json={"name": "Doc API"})
    doc_id = create.json()["id"]

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/document")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")
    body = resp.json()
    assert body["id"] == doc_id
    assert body["name"] == "Doc API"
    assert body["version"] == 0
    assert body["snapshot_version"] == 0
    assert body["pending_steps"] == 0
    assert body["content_markdown"] == "\n"  # empty paragraph


@pytest.mark.asyncio
async def test_get_document_markdown_accept(ds_paper):
    ds, paper_db = ds_paper

    create = await ds.client.post("/-/paper/api/docs", json={"name": "MD"})
    doc_id = create.json()["id"]

    rich_doc = {
        "type": "doc",
        "content": [
            {
                "type": "heading",
                "attrs": {"level": 1},
                "content": [{"type": "text", "text": "Title"}],
            },
            {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "hello "},
                    {
                        "type": "text",
                        "text": "world",
                        "marks": [{"type": "strong"}],
                    },
                ],
            },
            {
                "type": "bullet_list",
                "content": [
                    {
                        "type": "list_item",
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [{"type": "text", "text": "first"}],
                            }
                        ],
                    },
                    {
                        "type": "list_item",
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [{"type": "text", "text": "second"}],
                            }
                        ],
                    },
                ],
            },
        ],
    }
    await plant_snapshot(ds, doc_id, rich_doc)

    resp = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}/document",
        headers={"accept": "text/markdown"},
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/markdown")
    md = resp.text
    assert md.startswith("# Title")
    assert "hello **world**" in md
    assert "- first" in md
    assert "- second" in md

    resp = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}/document",
        headers={"accept": "application/markdown"},
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/markdown")

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/document")
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json()["content_markdown"] == md


@pytest.mark.asyncio
async def test_get_tasks_endpoint(ds_paper):
    ds, paper_db = ds_paper

    create = await ds.client.post("/-/paper/api/docs", json={"name": "Tasks"})
    doc_id = create.json()["id"]

    def _item(text, checked=False):
        return {
            "type": "task_item",
            "attrs": {"checked": checked},
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": text}],
                }
            ],
        }

    snapshot = {
        "type": "doc",
        "content": [
            {
                "type": "task_list",
                "content": [
                    _item("buy milk"),
                    _item("ship feature", checked=True),
                    _item("write tests"),
                ],
            },
        ],
    }
    await plant_snapshot(ds, doc_id, snapshot)

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tasks")
    assert resp.status_code == 200
    body = resp.json()
    assert body["doc_id"] == doc_id
    assert body["pending_steps"] == 0
    assert [t["text"] for t in body["tasks"]] == [
        "buy milk",
        "ship feature",
        "write tests",
    ]
    assert [t["checked"] for t in body["tasks"]] == [False, True, False]

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tasks?status=open")
    assert resp.status_code == 200
    open_tasks = resp.json()["tasks"]
    assert all(not t["checked"] for t in open_tasks)
    assert {t["text"] for t in open_tasks} == {"buy milk", "write tests"}

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tasks?status=done")
    assert resp.status_code == 200
    done_tasks = resp.json()["tasks"]
    assert [t["text"] for t in done_tasks] == ["ship feature"]

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tasks?status=garbage")
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_get_tasks_groups_by_heading_section(ds_paper):
    ds, paper_db = ds_paper

    create = await ds.client.post("/-/paper/api/docs", json={"name": "Sprints"})
    doc_id = create.json()["id"]

    def _item(text, checked=False):
        return {
            "type": "task_item",
            "attrs": {"checked": checked},
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": text}],
                }
            ],
        }

    def _h(level, text):
        return {
            "type": "heading",
            "attrs": {"level": level},
            "content": [{"type": "text", "text": text}],
        }

    snapshot = {
        "type": "doc",
        "content": [
            _h(2, "Sprint 1"),
            {"type": "task_list", "content": [_item("a"), _item("b")]},
            _h(3, "Sprint 1.2"),
            {"type": "task_list", "content": [_item("nested")]},
            _h(2, "Sprint 2"),
            {"type": "task_list", "content": [_item("c", checked=True)]},
        ],
    }
    await plant_snapshot(ds, doc_id, snapshot)

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tasks")
    assert resp.status_code == 200
    body = resp.json()

    assert [[s["text"] for s in t["section"]] for t in body["tasks"]] == [
        ["Sprint 1"],
        ["Sprint 1"],
        ["Sprint 1", "Sprint 1.2"],
        ["Sprint 2"],
    ]

    sections = body["sections"]
    assert [s["heading"] for s in sections] == [
        "Sprint 1",
        "Sprint 1.2",
        "Sprint 2",
    ]
    assert [s["level"] for s in sections] == [2, 3, 2]
    assert [[t["text"] for t in s["tasks"]] for s in sections] == [
        ["a", "b"],
        ["nested"],
        ["c"],
    ]

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tasks?status=done")
    assert resp.status_code == 200
    done = resp.json()
    assert [t["text"] for t in done["tasks"]] == ["c"]
    assert [s["heading"] for s in done["sections"]] == ["Sprint 2"]


@pytest.mark.asyncio
async def test_get_tasks_unknown_403(ds):
    resp = await ds.client.get("/-/paper/api/docs/99999/tasks")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_get_document_unknown_403(ds):
    resp = await ds.client.get("/-/paper/api/docs/99999/document")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_rename_doc_empty_name_400(ds):
    create = await ds.client.post("/-/paper/api/docs", json={"name": "Has Name"})
    doc_id = create.json()["id"]
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/rename",
        json={"name": "   "},
    )
    assert resp.status_code == 400
