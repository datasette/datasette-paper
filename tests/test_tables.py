"""Tests for `extract_tables` and the `/tables` API endpoints."""

import json

import pytest

from datasette_paper.markdown import doc_to_markdown
from datasette_paper.tables import (
    count_tables_with_name,
    extract_tables,
    find_table_by_name,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _doc(*blocks):
    return {"type": "doc", "content": list(blocks)}


def _para(text=""):
    content = [{"type": "text", "text": text}] if text else []
    return {"type": "paragraph", "content": content}


def _cell(text="", header=False):
    return {
        "type": "table_header" if header else "table_cell",
        "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
        "content": [_para(text)],
    }


def _row(*cells):
    return {"type": "table_row", "content": list(cells)}


def _table(name=None, *rows):
    attrs = {"name": name}
    return {"type": "table", "attrs": attrs, "content": list(rows)}


# ---------------------------------------------------------------------------
# extract_tables
# ---------------------------------------------------------------------------


def test_extract_tables_picks_up_named_table_with_header_row():
    doc = _doc(
        _table(
            "budget",
            _row(_cell("item", header=True), _cell("cost", header=True)),
            _row(_cell("coffee"), _cell("4")),
            _row(_cell("beans"), _cell("12")),
        )
    )
    tables = extract_tables(doc)
    assert tables == [
        {
            "name": "budget",
            "header": ["item", "cost"],
            "rows": [["coffee", "4"], ["beans", "12"]],
            "position": 0,
        }
    ]


def test_extract_tables_no_header_row_when_first_row_is_plain_cells():
    doc = _doc(
        _table(
            None,
            _row(_cell("a"), _cell("b")),
            _row(_cell("c"), _cell("d")),
        )
    )
    tables = extract_tables(doc)
    assert tables[0]["name"] is None
    assert tables[0]["header"] is None
    assert tables[0]["rows"] == [["a", "b"], ["c", "d"]]


def test_extract_tables_collects_multiple_tables_in_document_order():
    doc = _doc(
        _table("first", _row(_cell("x"))),
        {"type": "paragraph", "content": [{"type": "text", "text": "between"}]},
        _table("second", _row(_cell("y"))),
        _table(None, _row(_cell("z"))),
    )
    tables = extract_tables(doc)
    assert [t["name"] for t in tables] == ["first", "second", None]
    assert [t["position"] for t in tables] == [0, 1, 2]


def test_find_table_by_name_returns_first_match_and_count():
    doc = _doc(
        _table("dup", _row(_cell("a"))),
        _table("other", _row(_cell("b"))),
        _table("dup", _row(_cell("c"))),
    )
    found = find_table_by_name(doc, "dup")
    assert found is not None
    assert found["rows"] == [["a"]]
    assert count_tables_with_name(doc, "dup") == 2
    assert count_tables_with_name(doc, "missing") == 0


def test_render_table_to_markdown_emits_gfm_pipe_table():
    md = doc_to_markdown(
        _doc(
            _table(
                "budget",
                _row(_cell("item", header=True), _cell("cost", header=True)),
                _row(_cell("coffee"), _cell("4")),
            )
        )
    )
    assert "| item | cost |" in md
    assert "| --- | --- |" in md
    assert "| coffee | 4 |" in md


def test_render_table_handles_no_header_row_with_empty_header_line():
    md = doc_to_markdown(_doc(_table(None, _row(_cell("a"), _cell("b")))))
    # GFM requires a header — when there is none we synthesise an empty one.
    assert "|  |  |" in md  # empty header
    assert "| --- | --- |" in md
    assert "| a | b |" in md


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


async def _seed_doc_with_table_snapshot(ds, paper_db, name="Tables"):
    create = await ds.client.post("/-/paper/api/docs", json={"name": name})
    doc_id = create.json()["id"]
    snapshot = _doc(
        _table(
            "budget",
            _row(_cell("item", header=True), _cell("cost", header=True)),
            _row(_cell("coffee"), _cell("4")),
            _row(_cell("beans"), _cell("12")),
        ),
        _table(
            None,  # anonymous
            _row(_cell("x"), _cell("y")),
        ),
    )
    await paper_db.insert_snapshot(
        doc_id=doc_id, version=0, doc_json=json.dumps(snapshot), actor_id=None
    )
    from datasette_paper.instance import get_registry

    get_registry(ds)._instances.pop(doc_id, None)
    return doc_id


@pytest.mark.asyncio
async def test_list_tables_endpoint_returns_named_and_anonymous(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _seed_doc_with_table_snapshot(ds, paper_db)

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tables")
    assert resp.status_code == 200
    body = resp.json()
    assert body["doc_id"] == doc_id
    assert body["pending_steps"] == 0
    names = [t["name"] for t in body["tables"]]
    assert names == ["budget", None]
    budget = body["tables"][0]
    assert budget["columns"] == ["item", "cost"]
    assert budget["row_count"] == 2


@pytest.mark.asyncio
async def test_get_table_by_name_returns_header_and_rows(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _seed_doc_with_table_snapshot(ds, paper_db)

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tables/budget")
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "budget"
    assert body["header"] == ["item", "cost"]
    assert body["rows"] == [["coffee", "4"], ["beans", "12"]]
    assert body["doc_id"] == doc_id
    assert body["duplicates"] == 1  # one occurrence


@pytest.mark.asyncio
async def test_get_table_by_name_returns_404_for_missing_name(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _seed_doc_with_table_snapshot(ds, paper_db)

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tables/nope")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_table_by_name_reports_duplicates(ds_paper):
    ds, paper_db = ds_paper
    create = await ds.client.post("/-/paper/api/docs", json={"name": "Dup"})
    doc_id = create.json()["id"]
    snapshot = _doc(
        _table("dup", _row(_cell("a"))),
        _table("dup", _row(_cell("b"))),
    )
    await paper_db.insert_snapshot(
        doc_id=doc_id, version=0, doc_json=json.dumps(snapshot), actor_id=None
    )
    from datasette_paper.instance import get_registry

    get_registry(ds)._instances.pop(doc_id, None)

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tables/dup")
    assert resp.status_code == 200
    body = resp.json()
    assert body["rows"] == [["a"]]  # first match wins
    assert body["duplicates"] == 2


@pytest.mark.asyncio
async def test_tables_endpoints_require_view_permission(ds_paper):
    """Bob (no share) gets 403/forbidden on tables endpoints."""
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
        "/-/paper/api/docs", json={"name": "Private"}, cookies=alice
    )
    doc_id = create.json()["id"]

    from datasette_paper.db import PaperDB

    paper_db = PaperDB(ds.get_internal_database())
    snapshot = _doc(_table("budget", _row(_cell("a"))))
    await paper_db.insert_snapshot(
        doc_id=doc_id, version=0, doc_json=json.dumps(snapshot), actor_id=None
    )
    from datasette_paper.instance import get_registry

    get_registry(ds)._instances.pop(doc_id, None)

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tables", cookies=bob)
    assert resp.status_code in (403, 404)
    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tables/budget", cookies=bob)
    assert resp.status_code in (403, 404)
