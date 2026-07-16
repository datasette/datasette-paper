# @feat task-assign: tests the write-tail reindex into _datasette_paper_task_assignment
"""Tests for the write-tail task-assignment index reindex + backfill + purge.

Every write funnels through ``Instance._persist_and_broadcast``, whose tail
calls ``Instance.reindex_tasks`` to rebuild the doc's assigned-task rows in
``_datasette_paper_task_assignment`` wholesale (delete-all + re-insert per
doc). These drive real writes via ``append_fragment`` / ``apply_markdown_edit``
and assert the persisted rows. Assignment itself is exercised in
``test_markdown.py`` — this file is about the index staying in step.
"""

from __future__ import annotations

import pytest

from datasette_paper.instance import Instance


def _task(text="", *, checked=False, mentions=(), date=None, children=()):
    inlines: list[dict] = []
    if text:
        inlines.append({"type": "text", "text": text})
    for m in mentions:
        inlines.append({"type": "mention", "attrs": {"actorId": m}})
    if date:
        inlines.append(
            {"type": "date", "attrs": {"date": date, "time": None, "tz": None}}
        )
    content: list[dict] = [{"type": "paragraph", "content": inlines}]
    if children:
        content.append({"type": "task_list", "content": list(children)})
    return {"type": "task_item", "attrs": {"checked": checked}, "content": content}


def _task_list(*items):
    return {"type": "task_list", "content": list(items)}


async def _rows(ds, doc_id: int) -> list[dict]:
    r = await ds.get_internal_database().execute(
        "SELECT ordinal, assignee, inherited, checked, due_date, due_inherited "
        "FROM _datasette_paper_task_assignment WHERE doc_id = ? "
        "ORDER BY ordinal, assignee",
        [doc_id],
    )
    return [dict(row) for row in r.rows]


@pytest.mark.asyncio
async def test_reindex_writes_assigned_rows_only(ds_paper):
    ds, db = ds_paper
    doc = await db.insert_doc(name="Todos")
    inst = await Instance.hydrate(db, doc.id)

    await inst.append_fragment(
        [
            _task_list(
                _task("ship it", mentions=["marta", "dev"], date="2026-07-20"),
                _task("unassigned chore"),  # no mention → no rows
            )
        ],
        actor_id="alice",
    )

    rows = await _rows(ds, doc.id)
    # Two assignees on task 0, fanned out; task 1 (unassigned) writes nothing.
    assert [(r["ordinal"], r["assignee"]) for r in rows] == [
        (0, "dev"),
        (0, "marta"),
    ]
    assert all(r["due_date"] == "2026-07-20" for r in rows)
    assert all(r["inherited"] == 0 and r["due_inherited"] == 0 for r in rows)


@pytest.mark.asyncio
async def test_reindex_records_inherited_subtask(ds_paper):
    ds, db = ds_paper
    doc = await db.insert_doc(name="Nested")
    inst = await Instance.hydrate(db, doc.id)

    await inst.append_fragment(
        [
            _task_list(
                _task(
                    "parent",
                    mentions=["marta"],
                    date="2026-07-20",
                    children=[_task("silent subtask")],
                )
            )
        ],
        actor_id="alice",
    )

    rows = await _rows(ds, doc.id)
    assert [(r["ordinal"], r["assignee"]) for r in rows] == [(0, "marta"), (1, "marta")]
    parent, sub = rows
    assert parent["inherited"] == 0 and parent["due_inherited"] == 0
    # The subtask row is marked inherited on both facets.
    assert sub["inherited"] == 1 and sub["due_inherited"] == 1
    assert sub["due_date"] == "2026-07-20"


@pytest.mark.asyncio
async def test_reindex_clears_rows_when_mention_removed(ds_paper):
    ds, db = ds_paper
    doc = await db.insert_doc(name="Removal")
    inst = await Instance.hydrate(db, doc.id)

    await inst.append_fragment(
        [_task_list(_task("ship", mentions=["marta"]))], actor_id="alice"
    )
    assert await _rows(ds, doc.id)

    # Replace the whole doc with a mention-free task → reindex rebuilds empty.
    await inst.apply_markdown_edit(lambda _md: "- [ ] plain task", actor_id="alice")
    assert await _rows(ds, doc.id) == []


@pytest.mark.asyncio
async def test_reindex_flips_checked_and_reassigns(ds_paper):
    ds, db = ds_paper
    doc = await db.insert_doc(name="Mutate")
    inst = await Instance.hydrate(db, doc.id)

    # Nested task list authored as markdown; mentions round-trip via
    # [@id](paper:/actor/id). Parent ordinal 0, subtask ordinal 1.
    await inst.apply_markdown_edit(
        lambda _md: (
            "- [ ] [@marta](paper:/actor/marta) parent\n"
            "  - [ ] [@dev](paper:/actor/dev) sub\n"
        ),
        actor_id="alice",
    )
    rows = await _rows(ds, doc.id)
    assert [(r["ordinal"], r["assignee"], r["checked"]) for r in rows] == [
        (0, "marta", 0),
        (1, "dev", 0),
    ]

    # Check the parent's box and hand the subtask off to `other`.
    await inst.apply_markdown_edit(
        lambda _md: (
            "- [x] [@marta](paper:/actor/marta) parent\n"
            "  - [ ] [@other](paper:/actor/other) sub\n"
        ),
        actor_id="alice",
    )
    rows = await _rows(ds, doc.id)
    assert [(r["ordinal"], r["assignee"], r["checked"]) for r in rows] == [
        (0, "marta", 1),
        (1, "other", 0),
    ]


@pytest.mark.asyncio
async def test_reindex_version_guard_skips_redundant_rebuild(ds_paper):
    ds, db = ds_paper
    doc = await db.insert_doc(name="Guard")
    inst = await Instance.hydrate(db, doc.id)
    await inst.append_fragment(
        [_task_list(_task("ship", mentions=["marta"]))], actor_id="alice"
    )
    assert await _rows(ds, doc.id)

    # Wipe the rows out-of-band, then reindex with no version advance: the
    # in-memory guard (_tasks_indexed_version == version) short-circuits, so the
    # rows are NOT rebuilt. This is the same idempotence guard as links/tags.
    await ds.get_internal_database().execute_write(
        "DELETE FROM _datasette_paper_task_assignment WHERE doc_id = ?", [doc.id]
    )
    await inst.reindex_tasks()
    assert await _rows(ds, doc.id) == []


@pytest.mark.asyncio
async def test_hard_delete_purges_rows(ds_paper):
    ds, db = ds_paper
    doc = await db.insert_doc(name="Doomed")
    inst = await Instance.hydrate(db, doc.id)
    await inst.append_fragment(
        [_task_list(_task("ship", mentions=["marta"]))], actor_id="alice"
    )
    assert await _rows(ds, doc.id)

    await db.hard_delete_doc(doc_id=doc.id)
    assert await _rows(ds, doc.id) == []


@pytest.mark.asyncio
async def test_backfill_indexes_untouched_docs(ds):
    """A doc snapshotted but never edited after deploy is indexed by the backfill."""
    from datasette_paper.db import PaperDB
    from datasette_paper.instance import get_registry
    from datasette_paper.migrations import backfill_task_assignments

    db = PaperDB(ds.get_internal_database())
    doc = await db.insert_doc(name="Legacy")
    # Plant a snapshot with an assigned task directly (no write-tail reindex).
    import json

    snapshot = {
        "type": "doc",
        "content": [_task_list(_task("ship", mentions=["marta"]))],
    }
    await db.insert_snapshot(
        doc_id=doc.id, version=0, doc_json=json.dumps(snapshot), actor_id=None
    )
    get_registry(ds)._instances.pop(doc.id, None)

    # No rows yet — nothing has driven a reindex.
    assert await _rows(ds, doc.id) == []

    stats = await backfill_task_assignments(ds, force=True)
    assert stats["skipped"] is False
    rows = await _rows(ds, doc.id)
    assert [(r["ordinal"], r["assignee"]) for r in rows] == [(0, "marta")]

    # Marker now set → a non-forced second pass is a no-op (and wouldn't
    # duplicate rows even if it ran, since reindex is delete-then-insert).
    again = await backfill_task_assignments(ds)
    assert again["skipped"] is True
