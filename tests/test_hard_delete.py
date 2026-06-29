"""Regression tests for ``PaperDB.hard_delete_doc``.

A hard delete must wipe every child row the doc owns — not just steps and
snapshots, but its outgoing link edges (``_datasette_paper_link`` rows where
the doc is ``src``) and its document tags. Otherwise those rows are orphaned,
and because ``_datasette_paper_doc.id`` is ``INTEGER PRIMARY KEY`` with no
AUTOINCREMENT, SQLite reuses the deleted doc's rowid for the next-created doc,
which then inherits the stale edges/tags.

Inbound edges (rows where this doc is the ``dst``) are intentionally retained
(see the m005 design comment in ``migrations.py``).
"""

import pytest
from datasette.app import Datasette

from datasette_paper.db import PaperDB
from datasette_paper.migrations import ensure_migrations


async def make_paper_db() -> tuple[Datasette, PaperDB]:
    ds = Datasette(memory=True)
    internal = ds.get_internal_database()
    await ensure_migrations(internal)
    return ds, PaperDB(internal)


async def count_links_for_src(paper: PaperDB, src_doc_id: int) -> int:
    rows = await paper.links_by_src(src_doc_id=src_doc_id)
    return len(rows)


async def count_tag_rows(paper: PaperDB, doc_id: int) -> int:
    return len(await paper.list_tags_for_doc(doc_id=doc_id))


async def count_links_for_dst(ds: Datasette, dst_doc_id: int) -> int:
    rows = await ds.get_internal_database().execute(
        "SELECT 1 FROM _datasette_paper_link WHERE dst_doc_id = ?", [dst_doc_id]
    )
    return len(rows.rows)


@pytest.mark.asyncio
async def test_hard_delete_removes_orphan_links_and_tags():
    ds, paper = await make_paper_db()
    src = await paper.insert_doc(name="Src", created_by="alice")
    dst = await paper.insert_doc(name="Dst", created_by="alice")

    # Outgoing link edge (src -> dst) and a document tag on src.
    await paper.replace_links(src_doc_id=src.id, src_version=1, edges={dst.id: 1})
    await paper.add_doc_tag(doc_id=src.id, tag="roadmap")

    assert await count_links_for_src(paper, src.id) == 1
    assert await count_tag_rows(paper, src.id) == 1

    await paper.hard_delete_doc(doc_id=src.id)

    # The src's outgoing edges and tags are gone.
    assert await count_links_for_src(paper, src.id) == 0
    assert await count_tag_rows(paper, src.id) == 0


@pytest.mark.asyncio
async def test_hard_delete_preserves_inbound_edges():
    ds, paper = await make_paper_db()
    src = await paper.insert_doc(name="Src", created_by="alice")
    dst = await paper.insert_doc(name="Dst", created_by="alice")

    # src -> dst, then hard-delete the *destination* doc.
    await paper.replace_links(src_doc_id=src.id, src_version=1, edges={dst.id: 1})
    assert await count_links_for_dst(ds, dst.id) == 1

    await paper.hard_delete_doc(doc_id=dst.id)

    # The edge survives (src is still around; it resolves as 'not found' at
    # read time). delete_links_for_src only removes rows where dst is the src.
    assert await count_links_for_dst(ds, dst.id) == 1
    assert await count_links_for_src(paper, src.id) == 1


@pytest.mark.asyncio
async def test_rowid_reuse_does_not_inherit_links_or_tags():
    ds, paper = await make_paper_db()
    target = await paper.insert_doc(name="Target", created_by="alice")
    other = await paper.insert_doc(name="Other", created_by="alice")

    await paper.replace_links(src_doc_id=target.id, src_version=1, edges={other.id: 1})
    await paper.add_doc_tag(doc_id=target.id, tag="stale")

    # Delete the doc holding the max rowid so SQLite reuses it on next insert.
    await paper.insert_doc(name="Top", created_by="alice")  # bump max rowid
    top_id = (
        await ds.get_internal_database().execute(
            "SELECT max(id) FROM _datasette_paper_doc"
        )
    ).rows[0][0]
    await paper.hard_delete_doc(doc_id=top_id)
    # Now delete the target itself and recreate -> may reuse target.id.
    await paper.hard_delete_doc(doc_id=target.id)

    # No orphan rows linger under the deleted target id...
    assert await count_links_for_src(paper, target.id) == 0
    assert await count_tag_rows(paper, target.id) == 0

    # ...so a newly-created doc (which may reuse that rowid) starts clean.
    reused = await paper.insert_doc(name="Reused", created_by="alice")
    assert await count_links_for_src(paper, reused.id) == 0
    assert await count_tag_rows(paper, reused.id) == 0
