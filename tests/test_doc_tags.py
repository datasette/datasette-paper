"""Tests for the document-level tag API.

- GET    /-/paper/api/docs/{id}/tags          (view-gated)
- POST   /-/paper/api/docs/{id}/tags/add       (manage-gated)
- POST   /-/paper/api/docs/{id}/tags/remove    (manage-gated)
- POST   /-/paper/api/docs/{id}/tags/replace   (manage-gated)
- GET    /-/paper/api/tags                      (ungated, ACL-filtered)
- GET    /-/paper/api/docs?tag=a&tag=b          (intersection filter)

See routes/docs.py. Storage-layer + normalize_tag coverage is in
test_doc_tags_db.py.
"""

import pytest

from conftest import actor_cookie, create_doc, grant_role, setup_paper_datasette


# ---------------------------------------------------------------------------
# CRUD happy paths (owner)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_add_remove_list_tags():
    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")

    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/tags/add", json={"tag": "roadmap"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["tags"] == ["roadmap"]

    await ds.client.post(f"/-/paper/api/docs/{doc_id}/tags/add", json={"tag": "q3"})

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tags")
    assert resp.json()["tags"] == ["q3", "roadmap"]

    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/tags/remove", json={"tag": "q3"}
    )
    assert resp.json()["tags"] == ["roadmap"]


@pytest.mark.asyncio
async def test_replace_tags_dedupes_and_normalizes():
    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")

    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/tags/replace",
        json={"tags": ["Road Map", "road-map", "Q3", "!!!"]},
    )
    assert resp.status_code == 200, resp.text
    # "Road Map" and "road-map" collapse; "!!!" is dropped as invalid.
    assert resp.json()["tags"] == ["q3", "road-map"]


@pytest.mark.asyncio
async def test_add_tag_normalizes_to_canonical_form():
    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")

    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/tags/add", json={"tag": "  Road Map "}
    )
    assert resp.json()["tags"] == ["road-map"]


@pytest.mark.asyncio
async def test_add_invalid_tag_400():
    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")

    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/tags/add", json={"tag": "!!!"}
    )
    assert resp.status_code == 400, resp.text


# ---------------------------------------------------------------------------
# Permission gating
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mutations_require_manage():
    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob")  # bob can view, not manage
    bob = actor_cookie(ds, "bob")

    # A viewer can read the tags...
    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tags", cookies=bob)
    assert resp.status_code == 200, resp.text

    # ...but not mutate them.
    for path, body in [
        (f"/-/paper/api/docs/{doc_id}/tags/add", {"tag": "x"}),
        (f"/-/paper/api/docs/{doc_id}/tags/remove", {"tag": "x"}),
        (f"/-/paper/api/docs/{doc_id}/tags/replace", {"tags": ["x"]}),
    ]:
        resp = await ds.client.post(path, json=body, cookies=bob)
        assert resp.status_code == 403, (path, resp.text)


# ---------------------------------------------------------------------------
# Vocabulary endpoint — ACL-scoped counts
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_tags_is_acl_scoped():
    ds, _ = await setup_paper_datasette()
    d1 = await create_doc(ds, "Mine 1", actor_id="alice")
    d2 = await create_doc(ds, "Mine 2", actor_id="alice")
    # carol's private doc — alice can't view it, so its tags must not surface.
    d3 = await create_doc(ds, "Carol", actor_id="carol")

    await ds.client.post(f"/-/paper/api/docs/{d1}/tags/add", json={"tag": "shared"})
    await ds.client.post(f"/-/paper/api/docs/{d2}/tags/add", json={"tag": "shared"})
    await ds.client.post(f"/-/paper/api/docs/{d2}/tags/add", json={"tag": "only"})
    await ds.client.post(
        f"/-/paper/api/docs/{d3}/tags/add",
        json={"tag": "hidden"},
        cookies=actor_cookie(ds, "carol"),
    )

    resp = await ds.client.get("/-/paper/api/tags")  # as alice (default)
    assert resp.status_code == 200, resp.text
    counts = {t["tag"]: t["count"] for t in resp.json()["tags"]}
    assert counts == {"shared": 2, "only": 1}  # "hidden" not visible to alice


# ---------------------------------------------------------------------------
# List filter
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_docs_filter_by_tag_intersection():
    ds, _ = await setup_paper_datasette()
    d1 = await create_doc(ds, "One", actor_id="alice")
    d2 = await create_doc(ds, "Two", actor_id="alice")
    d3 = await create_doc(ds, "Three", actor_id="alice")

    await ds.client.post(
        f"/-/paper/api/docs/{d1}/tags/replace", json={"tags": ["a", "b"]}
    )
    await ds.client.post(f"/-/paper/api/docs/{d2}/tags/replace", json={"tags": ["a"]})
    await ds.client.post(f"/-/paper/api/docs/{d3}/tags/replace", json={"tags": ["b"]})

    async def ids(query):
        resp = await ds.client.get(f"/-/paper/api/docs{query}")
        assert resp.status_code == 200, resp.text
        return {d["id"] for d in resp.json()}

    assert await ids("") == {d1, d2, d3}
    assert await ids("?tag=a") == {d1, d2}
    assert await ids("?tag=a&tag=b") == {d1}  # intersection
    # Display-form filter normalizes to match stored tags.
    assert await ids("?tag=A") == {d1, d2}


@pytest.mark.asyncio
async def test_list_includes_tags_per_doc():
    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/tags/replace", json={"tags": ["x", "y"]}
    )

    resp = await ds.client.get("/-/paper/api/docs")
    doc = next(d for d in resp.json() if d["id"] == doc_id)
    assert doc["tags"] == ["x", "y"]
