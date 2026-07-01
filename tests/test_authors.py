"""Tests for the document authors byline API + eligibility constraint.

- GET  /-/paper/api/docs/{id}/authors            (view-gated, resolved)
- GET  /-/paper/api/docs/{id}/author-candidates   (manage-gated)
- POST /-/paper/api/docs/{id}/authors/add         (manage-gated + eligibility)
- POST /-/paper/api/docs/{id}/authors/remove      (manage-gated)
- POST /-/paper/api/docs/{id}/authors/replace     (manage-gated + eligibility)

Requirements: a doc's creator is seeded as author #0; only managers may change
the byline; an author must currently hold edit/manage access (grant-based, so
a locked doc stays authorable); replace grandfathers already-credited authors.

See routes/docs.py + permissions.author_candidates. Storage-layer coverage is
in test_authors_db.py.
"""

import pytest

from conftest import (
    actor_cookie,
    build_ds,
    create_doc,
    grant_role,
    revoke_role,
    setup_paper_datasette,
)
from datasette_paper.db import PaperDB
from datasette_paper.permissions import author_candidates

# @feat authors: proof of the manager-curated byline — creator seeding, the
# manage gate on mutations, and the edit/manage-access eligibility constraint.


# ---------------------------------------------------------------------------
# Creator seeding
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_creator_seeded_as_first_author():
    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/authors")
    assert resp.status_code == 200, resp.text
    authors = resp.json()["authors"]
    assert [a["id"] for a in authors] == ["alice"]


@pytest.mark.asyncio
async def test_anonymous_create_seeds_no_authors():
    ds = await build_ds()
    # Anonymous create (no cookie) → created_by is None → empty byline. Such a
    # doc has no acl grants, so it isn't HTTP-readable by anyone; assert the
    # empty byline at the db layer.
    resp = await ds.client.post("/-/paper/api/docs", json={"name": "Anon"})
    assert resp.status_code == 201, resp.text
    doc_id = resp.json()["id"]

    db = PaperDB(ds.get_internal_database())
    assert await db.list_authors_for_doc(doc_id=doc_id) == []


# ---------------------------------------------------------------------------
# Read gating
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_viewer_can_read_byline():
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob", "Viewer")

    r = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}/authors", cookies=actor_cookie(ds, "bob")
    )
    assert r.status_code == 200
    assert [a["id"] for a in r.json()["authors"]] == ["alice"]


@pytest.mark.asyncio
async def test_stranger_cannot_read_byline():
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")

    r = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}/authors", cookies=actor_cookie(ds, "mallory")
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Mutation gating (manager-only)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["authors/add", "authors/remove", "authors/replace"])
async def test_viewer_cannot_mutate(path):
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob", "Viewer")

    body = {"authors": []} if path.endswith("replace") else {"actor_id": "bob"}
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/{path}",
        json=body,
        cookies=actor_cookie(ds, "bob"),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_editor_cannot_mutate():
    """An Editor can edit the doc body but not curate the byline (manage-only)."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob", "Editor")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/authors/add",
        json={"actor_id": "bob"},
        cookies=actor_cookie(ds, "bob"),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_candidates_manager_only():
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob", "Editor")

    # Editor is denied the candidate list (it discloses the editor set).
    r = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}/author-candidates",
        cookies=actor_cookie(ds, "bob"),
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# The eligibility constraint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manager_can_add_an_editor():
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob", "Editor")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/authors/add",
        json={"actor_id": "bob"},
        cookies=actor_cookie(ds, "alice"),
    )
    assert r.status_code == 200, r.text
    assert [a["id"] for a in r.json()["authors"]] == ["alice", "bob"]


@pytest.mark.asyncio
async def test_manager_cannot_add_a_viewer():
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "vic", "Viewer")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/authors/add",
        json={"actor_id": "vic"},
        cookies=actor_cookie(ds, "alice"),
    )
    assert r.status_code == 400
    assert r.json()["error"] == "not an eligible author"


@pytest.mark.asyncio
async def test_add_empty_actor_id_400():
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/authors/add",
        json={"actor_id": "  "},
        cookies=actor_cookie(ds, "alice"),
    )
    assert r.status_code == 400
    assert r.json()["error"] == "invalid actor_id"


@pytest.mark.asyncio
async def test_candidates_excludes_current_authors_and_viewers():
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob", "Editor")
    await grant_role(ds, doc_id, "vic", "Viewer")

    r = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}/author-candidates",
        cookies=actor_cookie(ds, "alice"),
    )
    assert r.status_code == 200, r.text
    ids = {c["id"] for c in r.json()["results"]}
    # alice is already an author (seeded); vic is a viewer → neither eligible.
    assert ids == {"bob"}


# ---------------------------------------------------------------------------
# Remove + replace (reorder, grandfathering)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_remove_author():
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob", "Editor")
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/authors/add",
        json={"actor_id": "bob"},
        cookies=actor_cookie(ds, "alice"),
    )

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/authors/remove",
        json={"actor_id": "bob"},
        cookies=actor_cookie(ds, "alice"),
    )
    assert r.status_code == 200, r.text
    assert [a["id"] for a in r.json()["authors"]] == ["alice"]


@pytest.mark.asyncio
async def test_replace_reorders():
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob", "Editor")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/authors/replace",
        json={"authors": ["bob", "alice"]},
        cookies=actor_cookie(ds, "alice"),
    )
    assert r.status_code == 200, r.text
    assert [a["id"] for a in r.json()["authors"]] == ["bob", "alice"]


@pytest.mark.asyncio
async def test_replace_rejects_ineligible_new_id():
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "vic", "Viewer")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/authors/replace",
        json={"authors": ["alice", "vic"]},
        cookies=actor_cookie(ds, "alice"),
    )
    assert r.status_code == 400
    assert "vic" in r.json()["ineligible"]


@pytest.mark.asyncio
async def test_replace_grandfathers_revoked_author():
    """A co-author who since lost edit access can still be reordered."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob", "Editor")
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/authors/add",
        json={"actor_id": "bob"},
        cookies=actor_cookie(ds, "alice"),
    )
    # bob loses edit access but is still a credited author.
    await revoke_role(ds, doc_id, "bob")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/authors/replace",
        json={"authors": ["bob", "alice"]},
        cookies=actor_cookie(ds, "alice"),
    )
    assert r.status_code == 200, r.text
    assert [a["id"] for a in r.json()["authors"]] == ["bob", "alice"]


# ---------------------------------------------------------------------------
# author_candidates helper — grant-based, lock-robust
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_author_candidates_includes_editor_excludes_viewer():
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob", "Editor")
    await grant_role(ds, doc_id, "vic", "Viewer")

    eligible, open_audience = await author_candidates(ds, doc_id)
    assert "alice" in eligible  # manager
    assert "bob" in eligible  # editor
    assert "vic" not in eligible  # viewer
    assert open_audience is False


@pytest.mark.asyncio
async def test_author_candidates_lock_robust():
    """A locked doc denies paper-edit to everyone, but the editor is still an
    eligible author (candidacy is grant-based, not allowed()-based)."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "Doc", actor_id="alice")
    await grant_role(ds, doc_id, "bob", "Editor")

    # Lock the doc (manager-only op).
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )
    assert r.status_code == 200, r.text

    eligible, _ = await author_candidates(ds, doc_id)
    assert {"alice", "bob"} <= eligible
