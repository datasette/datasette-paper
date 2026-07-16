# @feat task-assign: tests the cross-doc /todos endpoint + its viewer-acl filter
"""Tests for GET /-/paper/api/profile/<actor>/todos.

The single endpoint both TODO surfaces consume. Assignment rows are inserted
directly into ``_datasette_paper_task_assignment`` here — the reindex that
*fills* the table is covered in test_task_assign_reindex.py; this file is about
the endpoint reading it back with the right acl filter, status filter, and
ordering. Inserting rows directly is deliberate: it lets the ACL test prove
filtering happens at *query* time (the hidden doc's rows exist in the table).
"""

import pytest

from conftest import actor_cookie, create_doc, grant_role, setup_paper_datasette


async def _todos(ds, viewer, actor, query=""):
    url = f"/-/paper/api/profile/{actor}/todos{query}"
    resp = await ds.client.get(url, cookies=actor_cookie(ds, viewer))
    return resp.status_code, resp.json()


async def _assign(
    ds,
    *,
    doc_id,
    ordinal,
    assignee,
    checked=0,
    due_date=None,
    due_time=None,
    due_tz=None,
    inherited=0,
    due_inherited=0,
    text="task",
    section="[]",
):
    await ds.get_internal_database().execute_write(
        "INSERT INTO _datasette_paper_task_assignment "
        "(doc_id, ordinal, assignee, inherited, checked, text, section, "
        " due_date, due_time, due_tz, due_inherited, src_version) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            doc_id,
            ordinal,
            assignee,
            inherited,
            checked,
            text,
            section,
            due_date,
            due_time,
            due_tz,
            due_inherited,
            1,
        ],
    )


@pytest.mark.asyncio
async def test_lists_assignee_tasks_across_docs():
    ds, paper = await setup_paper_datasette()
    a = await create_doc(ds, "A", actor_id="pat")
    b = await create_doc(ds, "B", actor_id="pat")
    await grant_role(ds, a, "vic")
    await grant_role(ds, b, "vic")
    await _assign(ds, doc_id=a, ordinal=0, assignee="pat", text="in A")
    await _assign(ds, doc_id=b, ordinal=0, assignee="pat", text="in B")
    # A task assigned to someone else — must not appear for pat.
    await _assign(ds, doc_id=a, ordinal=1, assignee="other", text="not pats")

    status, body = await _todos(ds, "vic", "pat")
    assert status == 200
    assert body["actor_id"] == "pat"
    assert {t["text"] for t in body["todos"]} == {"in A", "in B"}
    row = next(t for t in body["todos"] if t["text"] == "in A")
    assert row["doc_name"] == "A"
    assert row["doc_url"] == f"/-/paper/doc/{a}"

    # A never-assigned actor → empty (not 403; anyone may ask about anyone).
    status, body = await _todos(ds, "vic", "nobody")
    assert status == 200
    assert body == {"actor_id": "nobody", "todos": []}


@pytest.mark.asyncio
async def test_acl_filters_at_query_time_even_for_own_todos():
    """pat is assigned in both A and B, but the *viewer* can't see B → only A.
    The B rows exist in the table (filter-at-query, not filter-at-index)."""
    ds, paper = await setup_paper_datasette()
    a = await create_doc(ds, "A", actor_id="pat")  # pat owns → pat can view
    b = await create_doc(ds, "B", actor_id="other")  # pat has NO grant on B
    await _assign(ds, doc_id=a, ordinal=0, assignee="pat", text="visible")
    await _assign(ds, doc_id=b, ordinal=0, assignee="pat", text="hidden")

    # pat views their OWN todos; B is still filtered because pat can't view it.
    status, body = await _todos(ds, "pat", "pat")
    assert status == 200
    assert [t["text"] for t in body["todos"]] == ["visible"]

    # The hidden row really is in the table.
    rows = await ds.get_internal_database().execute(
        "SELECT count(*) AS c FROM _datasette_paper_task_assignment WHERE doc_id = ?",
        [b],
    )
    assert rows.rows[0]["c"] == 1


@pytest.mark.asyncio
async def test_inactive_and_template_docs_excluded_restore_brings_back():
    ds, paper = await setup_paper_datasette()
    active = await create_doc(ds, "Active", actor_id="pat")
    archived = await create_doc(ds, "Archived", actor_id="pat")
    trashed = await create_doc(ds, "Trashed", actor_id="pat")
    template = await create_doc(ds, "Template", actor_id="pat", kind="template")
    for d in (active, archived, trashed, template):
        await grant_role(ds, d, "vic")
        await _assign(ds, doc_id=d, ordinal=0, assignee="pat", text=f"t{d}")

    await paper.archive_doc(doc_id=archived)
    await paper.trash_doc(doc_id=trashed, delete_at="2099-12-31T00:00:00.000Z")

    status, body = await _todos(ds, "vic", "pat")
    assert [t["doc_name"] for t in body["todos"]] == ["Active"]

    # Restoring the archived doc brings its task back with no reindex.
    await paper.unarchive_doc(doc_id=archived)
    status, body = await _todos(ds, "vic", "pat")
    assert {t["doc_name"] for t in body["todos"]} == {"Active", "Archived"}


@pytest.mark.asyncio
async def test_status_filter():
    ds, paper = await setup_paper_datasette()
    a = await create_doc(ds, "A", actor_id="pat")
    await grant_role(ds, a, "vic")
    await _assign(ds, doc_id=a, ordinal=0, assignee="pat", checked=0, text="open one")
    await _assign(ds, doc_id=a, ordinal=1, assignee="pat", checked=1, text="done one")

    # Default = open.
    _, body = await _todos(ds, "vic", "pat")
    assert [t["text"] for t in body["todos"]] == ["open one"]

    _, body = await _todos(ds, "vic", "pat", "?status=done")
    assert [t["text"] for t in body["todos"]] == ["done one"]

    _, body = await _todos(ds, "vic", "pat", "?status=all")
    assert {t["text"] for t in body["todos"]} == {"open one", "done one"}

    status, _ = await _todos(ds, "vic", "pat", "?status=garbage")
    assert status == 400


@pytest.mark.asyncio
async def test_ordering_dated_first_then_undated():
    ds, paper = await setup_paper_datasette()
    a = await create_doc(ds, "A", actor_id="pat")
    await grant_role(ds, a, "vic")
    await _assign(ds, doc_id=a, ordinal=0, assignee="pat", text="no due")
    await _assign(
        ds, doc_id=a, ordinal=1, assignee="pat", due_date="2026-08-01", text="later"
    )
    await _assign(
        ds, doc_id=a, ordinal=2, assignee="pat", due_date="2026-07-01", text="sooner"
    )

    _, body = await _todos(ds, "vic", "pat", "?status=all")
    # Dated ascending, then undated last.
    assert [t["text"] for t in body["todos"]] == ["sooner", "later", "no due"]


@pytest.mark.asyncio
async def test_row_shape_co_assignees_and_inherited_flags():
    ds, paper = await setup_paper_datasette()
    a = await create_doc(ds, "A", actor_id="pat")
    await grant_role(ds, a, "vic")
    # Two co-assignees on the same task (two index rows, same ordinal).
    await _assign(
        ds,
        doc_id=a,
        ordinal=0,
        assignee="pat",
        inherited=1,
        due_date="2026-07-20",
        due_time="15:00",
        due_tz="America/New_York",
        due_inherited=1,
        section='[{"level": 2, "text": "Backend"}]',
        text="ship it",
    )
    await _assign(ds, doc_id=a, ordinal=0, assignee="dev", text="ship it")

    _, body = await _todos(ds, "vic", "pat", "?status=all")
    (row,) = body["todos"]
    assert set(row["assignees"]) == {"pat", "dev"}
    assert row["assignees_inherited"] is True
    assert "assignee_inherited" not in row
    assert row["due"] == {
        "date": "2026-07-20",
        "time": "15:00",
        "tz": "America/New_York",
    }
    assert row["due_inherited"] is True
    assert row["section"] == [{"level": 2, "text": "Backend"}]


@pytest.mark.asyncio
async def test_viewer_with_no_grants_is_empty():
    ds, paper = await setup_paper_datasette()
    a = await create_doc(ds, "A", actor_id="pat")
    await _assign(ds, doc_id=a, ordinal=0, assignee="pat", text="in A")
    # stranger holds no paper-view grants → short-circuits to empty.
    status, body = await _todos(ds, "stranger", "pat")
    assert status == 200
    assert body == {"actor_id": "pat", "todos": []}


@pytest.mark.asyncio
async def test_permission_pagination_does_not_hide_todos(monkeypatch):
    """A task beyond the permission API's old 1,000-resource cap is visible."""
    ds, paper = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Late grant", actor_id="pat")
    await _assign(ds, doc_id=doc_id, ordinal=0, assignee="pat", text="still visible")

    async def all_viewable_doc_ids(datasette, actor):
        assert datasette is ds
        assert actor == {"id": "vic"}
        return [*range(1, 1001), doc_id]

    monkeypatch.setattr(
        "datasette_paper.routes.docs.viewable_doc_ids", all_viewable_doc_ids
    )

    status, body = await _todos(ds, "vic", "pat")
    assert status == 200
    assert [todo["text"] for todo in body["todos"]] == ["still visible"]
