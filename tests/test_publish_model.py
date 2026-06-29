"""T01 — publication data model + materialize-at-version.

Covers the m007 storage (publication tables + ``published_version`` pointer),
``materialize_doc_at`` against a known step history (incl. snapshot selection
and edge versions), and the PaperDB publication helpers.
"""

from __future__ import annotations

import json

import pytest

from datasette_paper.instance import (
    Instance,
    empty_doc_json,
    materialize_doc_at,
)
from conftest import setup_paper_datasette


def _build_step_history(n: int):
    """Generate ``n`` real ProseMirror steps appending one paragraph each.

    Returns ``(step_jsons, doc_json_at)`` where ``doc_json_at[k]`` is the
    materialized doc JSON after applying steps 1..k over the empty doc.
    """
    from prosemirror.transform import Transform

    from datasette_paper.pm_schema import schema

    doc = schema.node_from_json(json.loads(empty_doc_json()))
    step_jsons: list[str] = []
    doc_json_at: dict[int, dict] = {0: doc.to_json()}
    for i in range(1, n + 1):
        para = schema.node("paragraph", None, [schema.text(f"line {i}")])
        tr = Transform(doc)
        tr.insert(doc.content.size, para)
        assert len(tr.steps) == 1, "expected a single step per insert"
        step_jsons.append(json.dumps(tr.steps[0].to_json()))
        doc = tr.doc
        doc_json_at[i] = doc.to_json()
    return step_jsons, doc_json_at


async def _seed_doc_with_history(paper, n: int, *, snapshot_at: int | None = None):
    """Create a doc, insert ``n`` steps (versions 1..n), optionally planting a
    mid-history snapshot. Returns ``(doc_id, doc_json_at)``."""
    step_jsons, doc_json_at = _build_step_history(n)
    doc = await paper.insert_doc(name="hist", created_by="alice")
    for step_json in step_jsons:
        await paper.insert_step(
            doc_id=doc.id, client_id=1, actor_id="alice", step_json=step_json
        )
    if snapshot_at is not None:
        await paper.insert_snapshot(
            doc_id=doc.id,
            version=snapshot_at,
            doc_json=json.dumps(doc_json_at[snapshot_at]),
            actor_id="alice",
        )
    return doc.id, doc_json_at


@pytest.mark.asyncio
async def test_migration_creates_publication_schema():
    ds, paper = await setup_paper_datasette()
    internal = ds.get_internal_database()

    def tables(conn):
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        return {r[0] for r in rows}

    names = await internal.execute_fn(tables)
    assert "_datasette_paper_publication" in names
    assert "_datasette_paper_publication_data" in names

    def doc_cols(conn):
        return {r[1] for r in conn.execute("PRAGMA table_info(_datasette_paper_doc)")}

    cols = await internal.execute_fn(doc_cols)
    assert "published_version" in cols


@pytest.mark.asyncio
async def test_materialize_at_matches_history_no_snapshot():
    ds, paper = await setup_paper_datasette()
    doc_id, doc_json_at = await _seed_doc_with_history(paper, 10)

    # Every intermediate version reconstructs exactly (snapshot at v0 only).
    for k in (0, 1, 5, 9, 10):
        got = await materialize_doc_at(paper, doc_id, k)
        assert got == doc_json_at[k], f"mismatch at version {k}"


@pytest.mark.asyncio
async def test_materialize_at_uses_nearest_snapshot():
    ds, paper = await setup_paper_datasette()
    # Snapshot planted exactly at v6; steps run to v12.
    doc_id, doc_json_at = await _seed_doc_with_history(paper, 12, snapshot_at=6)

    # version on the snapshot → snapshot returned directly.
    assert await materialize_doc_at(paper, doc_id, 6) == doc_json_at[6]
    # version after the snapshot → snapshot + steps 7..k applied.
    assert await materialize_doc_at(paper, doc_id, 9) == doc_json_at[9]
    assert await materialize_doc_at(paper, doc_id, 12) == doc_json_at[12]
    # version before the snapshot → falls back to the empty base + steps 1..k.
    assert await materialize_doc_at(paper, doc_id, 3) == doc_json_at[3]


@pytest.mark.asyncio
async def test_materialize_at_current_matches_live():
    ds, paper = await setup_paper_datasette()
    doc_id, doc_json_at = await _seed_doc_with_history(paper, 8, snapshot_at=4)

    instance = await Instance.hydrate(paper, doc_id)
    live = instance.materialize_live_doc()
    at = await materialize_doc_at(paper, doc_id, instance.version)
    assert at == live
    assert at == doc_json_at[8]


@pytest.mark.asyncio
async def test_materialize_at_zero_is_empty():
    ds, paper = await setup_paper_datasette()
    doc = await paper.insert_doc(name="blank", created_by="alice")
    got = await materialize_doc_at(paper, doc.id, 0)
    assert got == json.loads(empty_doc_json())


@pytest.mark.asyncio
async def test_publication_write_read_and_pointer():
    ds, paper = await setup_paper_datasette()
    doc = await paper.insert_doc(name="pub", created_by="alice")

    # Not published yet.
    assert await paper.select_published_version(doc_id=doc.id) is None
    assert await paper.select_current_publication(doc_id=doc.id) is None

    await paper.write_publication(
        doc_id=doc.id,
        version=3,
        html="<article>hi</article>",
        doc_json=empty_doc_json(),
        data_mode_default="live",
        config_json=json.dumps({"block_overrides": {}}),
        has_live_blocks=True,
        published_by="alice",
        frozen_data=[
            {
                "block_id": "b0",
                "kind": "sql",
                "payload_json": json.dumps({"columns": ["x"], "rows": [[1]]}),
                "computed_by": "alice",
            }
        ],
    )

    assert await paper.select_published_version(doc_id=doc.id) == 3
    pub = await paper.select_current_publication(doc_id=doc.id)
    assert pub is not None
    assert pub.version == 3
    assert pub.html == "<article>hi</article>"
    assert pub.has_live_blocks == 1

    data = await paper.select_publication_data(doc_id=doc.id, version=3)
    assert len(data) == 1
    assert data[0].block_id == "b0"
    assert json.loads(data[0].payload_json) == {"columns": ["x"], "rows": [[1]]}

    versions = await paper.list_publication_versions(doc_id=doc.id)
    assert [v.version for v in versions] == [3]

    # Unpublish keeps the row but clears the pointer.
    await paper.clear_published_version(doc_id=doc.id)
    assert await paper.select_published_version(doc_id=doc.id) is None
    assert await paper.select_current_publication(doc_id=doc.id) is None
    assert await paper.select_publication(doc_id=doc.id, version=3) is not None


@pytest.mark.asyncio
async def test_publication_data_replaced_on_republish():
    ds, paper = await setup_paper_datasette()
    doc = await paper.insert_doc(name="pub", created_by="alice")
    common = dict(
        doc_id=doc.id,
        version=1,
        html="<article/>",
        doc_json=empty_doc_json(),
        data_mode_default="frozen",
        config_json="{}",
        has_live_blocks=False,
        published_by="alice",
    )
    await paper.write_publication(
        **common,
        frozen_data=[
            {
                "block_id": "b0",
                "kind": "sql",
                "payload_json": "{}",
                "computed_by": None,
            },
            {
                "block_id": "b1",
                "kind": "sql",
                "payload_json": "{}",
                "computed_by": None,
            },
        ],
    )
    assert len(await paper.select_publication_data(doc_id=doc.id, version=1)) == 2

    # Re-publishing the same version replaces the frozen rows wholesale.
    await paper.write_publication(
        **common,
        frozen_data=[
            {"block_id": "b0", "kind": "sql", "payload_json": "{}", "computed_by": None}
        ],
    )
    rows = await paper.select_publication_data(doc_id=doc.id, version=1)
    assert [r.block_id for r in rows] == ["b0"]
