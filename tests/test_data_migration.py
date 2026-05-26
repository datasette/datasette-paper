"""Tests for the one-time legacy share/visibility → acl-grant data migration
(phase-05/03).

A real upgrade has *pre-existing* docs whose access lived in
``_datasette_paper_doc.created_by`` / ``.visibility`` and ``_datasette_paper_share``
rows, with no acl grants yet. ``migrate_shares_to_acl`` backfills those into acl
grants via acl's ``grant`` helper.

These tests seed that legacy state directly (raw inserts, *not* the create API,
which would already seed an owner grant), run the migration, then assert both
the resulting grants and the effective ``datasette.allowed`` outcomes, plus
idempotency.
"""

from __future__ import annotations

import pytest
from datasette.app import Datasette

from datasette_acl.grants import list_grants
from datasette_paper.migrations import (
    DEFAULT_GENERAL_PRINCIPAL,
    migrate_shares_to_acl,
)
from datasette_paper.permissions import (
    PAPER_DOC_RESOURCE_TYPE,
    PAPER_DOCS_PARENT,
    PaperDocResource,
)


async def _make_ds(config=None):
    base = {
        "permissions": {
            "datasette-paper-list": True,
            "datasette-paper-create": True,
        }
    }
    if config:
        base.update(config)
    ds = Datasette(memory=True, config=base)
    await ds.invoke_startup()
    return ds


async def _seed_doc(ds, *, doc_id, created_by, visibility="private", name="P"):
    """Insert a legacy doc row directly (bypassing the grant-seeding create path)."""
    db = ds.get_internal_database()
    await db.execute_write(
        "INSERT INTO _datasette_paper_doc (id, name, created_by, visibility) "
        "VALUES (?, ?, ?, ?)",
        [doc_id, name, created_by, visibility],
    )


async def _seed_share(ds, *, doc_id, actor_id, role, granted_by="alice"):
    db = ds.get_internal_database()
    await db.execute_write(
        "INSERT INTO _datasette_paper_share (doc_id, actor_id, role, granted_by) "
        "VALUES (?, ?, ?, ?)",
        [doc_id, actor_id, role, granted_by],
    )


async def _grant_map(ds, doc_id):
    """Return {actor_id: set(actions)} for actor grants on a doc."""
    grants = await list_grants(
        ds, PAPER_DOC_RESOURCE_TYPE, PAPER_DOCS_PARENT, str(doc_id)
    )
    return {
        g["actor_id"]: set(g["actions"])
        for g in grants
        if g["principal"] == "actor"
    }


# ---------------------------------------------------------------------------
# Owner → Manager
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_migrated_to_manager():
    ds = await _make_ds()
    await _seed_doc(ds, doc_id=1, created_by="alice", visibility="private")

    stats = await migrate_shares_to_acl(ds, force=True)
    assert stats["owners"] == 1
    assert stats["visibility"] == 0
    assert stats["shares"] == 0

    grants = await _grant_map(ds, 1)
    assert grants["alice"] == {"paper-view", "paper-edit", "paper-manage"}

    res = PaperDocResource(1)
    for action in ("paper-view", "paper-edit", "paper-manage"):
        assert await ds.allowed(action=action, resource=res, actor={"id": "alice"})
    # A stranger sees nothing on a private doc.
    assert not await ds.allowed(
        action="paper-view", resource=res, actor={"id": "bob"}
    )


@pytest.mark.asyncio
async def test_anonymous_owner_skipped():
    """created_by NULL (anonymous create) yields no owner grant."""
    ds = await _make_ds()
    await _seed_doc(ds, doc_id=1, created_by=None, visibility="private")

    stats = await migrate_shares_to_acl(ds, force=True)
    assert stats["owners"] == 0

    grants = await _grant_map(ds, 1)
    assert grants == {}


# ---------------------------------------------------------------------------
# Share rows → Viewer / Editor
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_share_rows_migrated_to_viewer_and_editor():
    ds = await _make_ds()
    await _seed_doc(ds, doc_id=1, created_by="alice")
    await _seed_share(ds, doc_id=1, actor_id="bob", role="viewer")
    await _seed_share(ds, doc_id=1, actor_id="carol", role="editor")

    stats = await migrate_shares_to_acl(ds, force=True)
    assert stats["owners"] == 1
    assert stats["shares"] == 2

    grants = await _grant_map(ds, 1)
    assert grants["bob"] == {"paper-view"}
    assert grants["carol"] == {"paper-view", "paper-edit"}

    res = PaperDocResource(1)
    # viewer can view, not edit
    assert await ds.allowed(action="paper-view", resource=res, actor={"id": "bob"})
    assert not await ds.allowed(
        action="paper-edit", resource=res, actor={"id": "bob"}
    )
    # editor can view + edit, not manage
    assert await ds.allowed(
        action="paper-edit", resource=res, actor={"id": "carol"}
    )
    assert not await ds.allowed(
        action="paper-manage", resource=res, actor={"id": "carol"}
    )


# ---------------------------------------------------------------------------
# Visibility → general-access principal grant
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_visibility_link_view_grants_signed_in_viewer():
    ds = await _make_ds()
    await _seed_doc(ds, doc_id=1, created_by="alice", visibility="link-view")

    stats = await migrate_shares_to_acl(ds, force=True)
    assert stats["visibility"] == 1

    grants = await _grant_map(ds, 1)
    assert grants[DEFAULT_GENERAL_PRINCIPAL] == {"paper-view"}

    res = PaperDocResource(1)
    # Any signed-in actor can view, but not edit.
    assert await ds.allowed(action="paper-view", resource=res, actor={"id": "zed"})
    assert not await ds.allowed(
        action="paper-edit", resource=res, actor={"id": "zed"}
    )
    # Anonymous (no id) does NOT match _signed_in.
    assert not await ds.allowed(action="paper-view", resource=res, actor=None)


@pytest.mark.asyncio
async def test_visibility_link_edit_grants_signed_in_editor():
    ds = await _make_ds()
    await _seed_doc(ds, doc_id=1, created_by="alice", visibility="link-edit")

    stats = await migrate_shares_to_acl(ds, force=True)
    assert stats["visibility"] == 1

    grants = await _grant_map(ds, 1)
    assert grants[DEFAULT_GENERAL_PRINCIPAL] == {"paper-view", "paper-edit"}

    res = PaperDocResource(1)
    assert await ds.allowed(action="paper-edit", resource=res, actor={"id": "zed"})
    assert not await ds.allowed(
        action="paper-manage", resource=res, actor={"id": "zed"}
    )


@pytest.mark.asyncio
async def test_private_visibility_grants_nothing_extra():
    """DECISIONS.md: upgrade default CLOSED — private docs stay owner-only."""
    ds = await _make_ds()
    await _seed_doc(ds, doc_id=1, created_by="alice", visibility="private")

    await migrate_shares_to_acl(ds, force=True)

    grants = await _grant_map(ds, 1)
    # Only the owner, no _signed_in / * principal.
    assert set(grants) == {"alice"}
    assert "_signed_in" not in grants
    assert "*" not in grants


# ---------------------------------------------------------------------------
# Configurable general principal
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_general_principal_configurable_to_wildcard():
    ds = await _make_ds(
        config={"plugins": {"datasette-paper": {"share-general-principal": "*"}}}
    )
    await _seed_doc(ds, doc_id=1, created_by="alice", visibility="link-view")

    await migrate_shares_to_acl(ds, force=True)

    grants = await _grant_map(ds, 1)
    assert "*" in grants
    assert grants["*"] == {"paper-view"}

    res = PaperDocResource(1)
    # '*' includes anonymous callers.
    assert await ds.allowed(action="paper-view", resource=res, actor=None)


@pytest.mark.asyncio
async def test_invalid_general_principal_falls_back_to_default():
    ds = await _make_ds(
        config={
            "plugins": {"datasette-paper": {"share-general-principal": "nonsense"}}
        }
    )
    await _seed_doc(ds, doc_id=1, created_by="alice", visibility="link-view")

    await migrate_shares_to_acl(ds, force=True)

    grants = await _grant_map(ds, 1)
    assert DEFAULT_GENERAL_PRINCIPAL in grants
    assert "nonsense" not in grants


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_marker_skips_repeat_run():
    ds = await _make_ds()
    await _seed_doc(ds, doc_id=1, created_by="alice", visibility="link-view")
    await _seed_share(ds, doc_id=1, actor_id="bob", role="editor")

    first = await migrate_shares_to_acl(ds, force=True)
    assert first["skipped"] is False
    assert first["owners"] == 1

    # Without force, the marker recorded by the first run short-circuits.
    second = await migrate_shares_to_acl(ds)
    assert second["skipped"] is True
    assert second["owners"] == 0


@pytest.mark.asyncio
async def test_forced_rerun_no_duplicate_grants_or_audit():
    """A forced second run must not duplicate grants or audit rows."""
    ds = await _make_ds()
    await _seed_doc(ds, doc_id=1, created_by="alice", visibility="link-edit")
    await _seed_share(ds, doc_id=1, actor_id="bob", role="viewer")
    await _seed_share(ds, doc_id=1, actor_id="carol", role="editor")

    await migrate_shares_to_acl(ds, force=True)

    db = ds.get_internal_database()
    acl_count_1 = (await db.execute("SELECT count(*) FROM acl")).single_value()
    audit_count_1 = (
        await db.execute("SELECT count(*) FROM acl_audit")
    ).single_value()
    grants_1 = await _grant_map(ds, 1)

    # Run again, forcing past the marker.
    await migrate_shares_to_acl(ds, force=True)

    acl_count_2 = (await db.execute("SELECT count(*) FROM acl")).single_value()
    audit_count_2 = (
        await db.execute("SELECT count(*) FROM acl_audit")
    ).single_value()
    grants_2 = await _grant_map(ds, 1)

    assert acl_count_2 == acl_count_1
    assert audit_count_2 == audit_count_1
    assert grants_2 == grants_1


# ---------------------------------------------------------------------------
# End-to-end multi-doc spot check
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mixed_corpus_migrates_correctly():
    ds = await _make_ds()
    # doc 1: private, owner alice, bob editor share
    await _seed_doc(ds, doc_id=1, created_by="alice", visibility="private")
    await _seed_share(ds, doc_id=1, actor_id="bob", role="editor")
    # doc 2: link-view, owner carol
    await _seed_doc(ds, doc_id=2, created_by="carol", visibility="link-view")
    # doc 3: link-edit, anonymous owner
    await _seed_doc(ds, doc_id=3, created_by=None, visibility="link-edit")

    stats = await migrate_shares_to_acl(ds, force=True)
    assert stats["owners"] == 2  # alice, carol (not anon doc 3)
    assert stats["shares"] == 1  # bob
    assert stats["visibility"] == 2  # doc 2 + doc 3

    # doc1: alice manages, bob edits, stranger denied
    r1 = PaperDocResource(1)
    assert await ds.allowed(action="paper-manage", resource=r1, actor={"id": "alice"})
    assert await ds.allowed(action="paper-edit", resource=r1, actor={"id": "bob"})
    assert not await ds.allowed(
        action="paper-view", resource=r1, actor={"id": "stranger"}
    )

    # doc2: carol manages, any signed-in views (not edits)
    r2 = PaperDocResource(2)
    assert await ds.allowed(action="paper-manage", resource=r2, actor={"id": "carol"})
    assert await ds.allowed(
        action="paper-view", resource=r2, actor={"id": "stranger"}
    )
    assert not await ds.allowed(
        action="paper-edit", resource=r2, actor={"id": "stranger"}
    )

    # doc3: no owner, any signed-in edits
    r3 = PaperDocResource(3)
    assert await ds.allowed(
        action="paper-edit", resource=r3, actor={"id": "stranger"}
    )
    assert len(await _grant_map(ds, 3)) == 1  # only the _signed_in principal


# ---------------------------------------------------------------------------
# Startup wiring + empty-DB behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_startup_marks_migration_on_empty_db():
    """startup() runs the migration once; with no docs it just records the marker."""
    ds = await _make_ds()
    db = ds.get_internal_database()
    # startup already ran the migration; the marker should exist.
    from datasette_paper.migrations import (
        _ACL_MIGRATION_KEY,
        _ACL_MIGRATION_TABLE,
    )

    rows = (
        await db.execute(
            f"SELECT key FROM {_ACL_MIGRATION_TABLE} WHERE key = ?",
            [_ACL_MIGRATION_KEY],
        )
    ).rows
    assert rows, "migration marker not recorded at startup"

    # A subsequent unforced run is a no-op.
    stats = await migrate_shares_to_acl(ds)
    assert stats["skipped"] is True
