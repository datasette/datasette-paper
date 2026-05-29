"""Tests for datasette_paper.links.extract_links + the m005 migration."""

import pytest
from datasette.app import Datasette

from datasette_paper.links import extract_links
from datasette_paper.migrations import ensure_migrations


def _link(doc_id):
    return {"type": "paper_link", "attrs": {"docId": doc_id}}


def _para(*content):
    return {"type": "paragraph", "content": list(content)}


def _doc(*content):
    return {"type": "doc", "content": list(content)}


# ---------------------------------------------------------------------------
# extract_links
# ---------------------------------------------------------------------------


def test_empty_non_link_doc():
    doc = _doc(_para({"type": "text", "text": "hello world"}))
    assert extract_links(doc) == []


def test_single_link():
    doc = _doc(_para(_link(42)))
    assert extract_links(doc) == [42]


def test_multiple_links_with_repeats_in_document_order():
    doc = _doc(
        _para(_link(1), {"type": "text", "text": " and "}, _link(2)),
        _para(_link(1)),
    )
    assert extract_links(doc) == [1, 2, 1]


def test_links_nested_in_list_items_and_table_cells():
    doc = _doc(
        {
            "type": "bullet_list",
            "content": [
                {
                    "type": "list_item",
                    "content": [_para(_link(10))],
                },
                {
                    "type": "list_item",
                    "content": [_para(_link(11))],
                },
            ],
        },
        {
            "type": "table",
            "content": [
                {
                    "type": "table_row",
                    "content": [
                        {"type": "table_cell", "content": [_para(_link(20))]},
                        {"type": "table_cell", "content": [_para(_link(21))]},
                    ],
                }
            ],
        },
    )
    assert extract_links(doc) == [10, 11, 20, 21]


def test_link_with_null_or_missing_docid_skipped():
    doc = _doc(
        _para(
            {"type": "paper_link", "attrs": {"docId": None}},
            {"type": "paper_link", "attrs": {}},
            {"type": "paper_link"},
            _link(7),
        )
    )
    assert extract_links(doc) == [7]


# ---------------------------------------------------------------------------
# m005 migration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_m005_creates_link_table():
    ds = Datasette(memory=True)
    internal = ds.get_internal_database()
    await ensure_migrations(internal)

    rows = await internal.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ["_datasette_paper_link"],
    )
    assert [r["name"] for r in rows] == ["_datasette_paper_link"]
