"""Tests for the datasette-paper document API routes."""

import json

import pytest


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
    # The list now includes per-row visibility + is_owner.
    assert docs[0]["visibility"] == "private"
    assert docs[0]["is_owner"] is True


@pytest.mark.asyncio
async def test_list_filters_to_actor_visible_papers():
    """Alice's papers should not appear in Bob's list."""
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
        "visibility": "private",
    }


@pytest.mark.asyncio
async def test_bootstrap_permissions_for_shared_viewer():
    """Bob (viewer) sees canEdit=False, canManage=False, isOwner=False."""
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

    # Hand-grant bob the viewer role.
    await ds.get_internal_database().execute_write(
        "INSERT INTO _datasette_paper_share (doc_id, actor_id, role, granted_by) "
        "VALUES (?, ?, 'viewer', 'alice')",
        [doc_id, "bob"],
    )

    boot = await ds.client.get(f"/-/paper/api/docs/{doc_id}", cookies=bob)
    perms = boot.json()["permissions"]
    assert perms["canEdit"] is False
    assert perms["canManage"] is False
    assert perms["isOwner"] is False
    assert perms["visibility"] == "private"


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
    ds, paper_db = ds_paper

    create_resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Snap Write Paper"}
    )
    assert create_resp.status_code == 201
    doc_id = create_resp.json()["id"]

    step_data = json.dumps({"stepType": "replace", "from": 1, "to": 1, "slice": {}})
    for i in range(100):
        await paper_db.insert_step(
            doc_id=doc_id,
            client_id=400,
            step_json=step_data,
        )

    from datasette_paper.instance import get_registry

    registry = get_registry(ds)
    registry._instances.pop(doc_id, None)

    snapshot_doc = {"type": "doc", "content": [{"type": "paragraph"}]}
    response = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/snapshot",
        json={"version": 100, "doc": snapshot_doc},
    )
    assert response.status_code == 204

    snapshot = await paper_db.select_latest_snapshot(doc_id=doc_id)
    assert snapshot is not None
    assert snapshot.version == 100


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
    await paper_db.insert_snapshot(
        doc_id=doc_id, version=0, doc_json=json.dumps(rich_doc), actor_id=None
    )
    from datasette_paper.instance import get_registry

    registry = get_registry(ds)
    registry._instances.pop(doc_id, None)

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
    await paper_db.insert_snapshot(
        doc_id=doc_id, version=0, doc_json=json.dumps(snapshot), actor_id=None
    )
    from datasette_paper.instance import get_registry

    registry = get_registry(ds)
    registry._instances.pop(doc_id, None)

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
    await paper_db.insert_snapshot(
        doc_id=doc_id, version=0, doc_json=json.dumps(snapshot), actor_id=None
    )
    from datasette_paper.instance import get_registry

    registry = get_registry(ds)
    registry._instances.pop(doc_id, None)

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
