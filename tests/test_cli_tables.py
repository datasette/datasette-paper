"""Tests for `datasette paper tables`.

Like `test_cli_list.py`, these boot a real file-backed Datasette (via
`tests/_cli.py`'s shared helpers) so the CLI reads from an actual internal
database file with no server running. Named tables round-trip through the
normal markdown append pipeline (the `paper-table` sidecar fence — see
`markdown_parser.py`'s `pending_table_name` handling — carries the `name`
attr, fixed by #45), so most fixtures are seeded via `append`/
`create_doc_with_content` like the other CLI test files. A table *without*
a header row can't be expressed in GFM markdown (every parsed table gets a
header row), so that one case plants an explicit snapshot doc, the same
`table`/`table_row`/`table_cell` node shape `tests/test_tables.py` uses.
"""

# @feat cli-tables: CLI tests for `paper tables` (file-backed internal db)

import json

import pytest

from conftest import plant_snapshot
from _cli import create_doc_with_content, file_backed_ds, run_cli


def _run_tables(db_path, doc_id, *extra):
    return run_cli("paper", "tables", db_path, str(doc_id), *extra)


async def _create_doc(ds, name="Tables"):
    resp = await ds.client.post("/-/paper/api/docs", json={"name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# ---------------------------------------------------------------------------
# Snapshot-node helpers (mirrors tests/test_tables.py)
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
    return {"type": "table", "attrs": {"name": name}, "content": list(rows)}


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_listing_shows_named_and_anonymous_tables_with_position_and_shape(
    tmp_path,
):
    ds, internal = await file_backed_ds(tmp_path)
    content = (
        '```paper-table\n{"name":"budget"}\n```\n'
        "| item | cost |\n| --- | --- |\n| coffee | 4 |\n| beans | 12 |\n\n"
        "| x | y | z |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n"
    )
    doc_id = await create_doc_with_content(ds, content=content)

    result = _run_tables(internal, doc_id)
    assert result.exit_code == 0, result.output
    lines = [line for line in result.output.splitlines() if line.strip()]
    assert len(lines) == 2

    by_position = {line.split()[0]: line.split() for line in lines}
    budget = by_position["0"]
    assert budget[1] == "budget"
    assert budget[2] == "2x2"  # 2 body rows, 2 cols

    anon = by_position["1"]
    assert anon[1] == "-"
    assert anon[2] == "1x3"  # 1 body row, 3 cols


@pytest.mark.asyncio
async def test_listing_json_emits_full_extract_tables_array(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    content = (
        '```paper-table\n{"name":"budget"}\n```\n'
        "| item | cost |\n| --- | --- |\n| coffee | 4 |\n"
    )
    doc_id = await create_doc_with_content(ds, content=content)

    result = _run_tables(internal, doc_id, "-f", "json")
    assert result.exit_code == 0, result.output
    tables = json.loads(result.output)
    assert tables == [
        {
            "name": "budget",
            "header": ["item", "cost"],
            "rows": [["coffee", "4"]],
            "position": 0,
        }
    ]


# ---------------------------------------------------------------------------
# CSV fetch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_csv_fetch_includes_header_row(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    content = (
        '```paper-table\n{"name":"budget"}\n```\n'
        "| item | cost |\n| --- | --- |\n| coffee | 4 |\n| beans | 12 |\n"
    )
    doc_id = await create_doc_with_content(ds, content=content)

    result = _run_tables(internal, doc_id, "budget")
    assert result.exit_code == 0, result.output
    assert result.output == "item,cost\ncoffee,4\nbeans,12\n"


@pytest.mark.asyncio
async def test_csv_fetch_no_header_row_emits_no_header_line(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    doc_id = await _create_doc(ds)
    snapshot = _doc(
        _table(
            "plain",
            _row(_cell("a"), _cell("b")),
            _row(_cell("c"), _cell("d")),
        )
    )
    await plant_snapshot(ds, doc_id, snapshot)

    result = _run_tables(internal, doc_id, "plain")
    assert result.exit_code == 0, result.output
    assert result.output == "a,b\nc,d\n"


@pytest.mark.asyncio
async def test_csv_fetch_escapes_commas_and_quotes(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    doc_id = await _create_doc(ds)
    snapshot = _doc(
        _table(
            "messy",
            _row(_cell("a,b"), _cell('c"d')),
        )
    )
    await plant_snapshot(ds, doc_id, snapshot)

    result = _run_tables(internal, doc_id, "messy")
    assert result.exit_code == 0, result.output
    assert result.output == '"a,b","c""d"\n'


# ---------------------------------------------------------------------------
# Parity with the /tables/{name} endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_json_fetch_matches_tables_endpoint(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    content = (
        '```paper-table\n{"name":"budget"}\n```\n'
        "| item | cost |\n| --- | --- |\n| coffee | 4 |\n| beans | 12 |\n"
    )
    doc_id = await create_doc_with_content(ds, content=content)

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tables/budget")
    assert resp.status_code == 200
    body = resp.json()
    endpoint_table = {
        "name": body["name"],
        "header": body["header"],
        "rows": body["rows"],
        "position": body["position"],
    }

    result = _run_tables(internal, doc_id, "budget", "-f", "json")
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == endpoint_table


# ---------------------------------------------------------------------------
# Duplicate names
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_duplicate_name_warns_on_stderr_stdout_stays_clean(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    content = (
        '```paper-table\n{"name":"dup"}\n```\n'
        "| a |\n| --- |\n| 1 |\n\n"
        '```paper-table\n{"name":"dup"}\n```\n'
        "| b |\n| --- |\n| 2 |\n"
    )
    doc_id = await create_doc_with_content(ds, content=content)

    result = _run_tables(internal, doc_id, "dup")
    assert result.exit_code == 0, result.output
    assert result.stdout == "a\n1\n"
    assert "warning: 2 tables named 'dup', using first in document order" in (
        result.stderr
    )


# ---------------------------------------------------------------------------
# Missing / empty name
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_name_exits_one(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    content = '```paper-table\n{"name":"budget"}\n```\n| item |\n| --- |\n| coffee |\n'
    doc_id = await create_doc_with_content(ds, content=content)

    result = _run_tables(internal, doc_id, "nope")
    assert result.exit_code == 1
    assert "No table named" in result.output


@pytest.mark.asyncio
async def test_empty_name_exits_one(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    doc_id = await create_doc_with_content(ds, content="# Title\n")

    result = _run_tables(internal, doc_id, "   ")
    assert result.exit_code == 1
    assert "must not be empty" in result.output


def test_tables_rejects_non_paper_db(tmp_path):
    import sqlite3

    stray = tmp_path / "stray.db"
    sqlite3.connect(stray).execute("CREATE TABLE t (x)").connection.close()

    result = _run_tables(str(stray), 1)
    assert result.exit_code == 1, result.output
    assert "has no paper tables" in result.output
