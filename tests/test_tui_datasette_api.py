"""Tests for datasette_paper.tui.datasette_api — the thin fetch layer over
Datasette's native JSON API.

The shared ``ds`` fixture (``conftest.py``) only attaches paper's internal
db, so these tests build their own ``Datasette`` — mirroring
``conftest.make_datasette`` plus a real ``files=`` content db (a few rows,
mixed types, one blob) — the way the ticket calls for verifying the actual
JSON API shapes rather than guessing them.
"""

from __future__ import annotations

import base64
import sqlite3

import httpx
import pytest
import pytest_asyncio
from datasette.app import Datasette

from datasette_paper.instance import MAX_STEP_BYTES
from datasette_paper.tui import datasette_api
from datasette_paper.tui.client import PaperClient

CONTENT_DB = "content"
BLOB_BYTES = b"\x00\x01\x02\xff"


def _build_content_db(path) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        "create table items (id integer primary key, name text, note text, "
        "blob_col blob)"
    )
    for i in range(25):
        conn.execute(
            "insert into items (name, note, blob_col) values (?, ?, ?)",
            (f"item{i}", "n" * 200, BLOB_BYTES if i == 0 else None),
        )
    conn.execute("create view items_view as select id, name from items")
    conn.commit()
    conn.close()


async def _build_ds(tmp_path) -> Datasette:
    db_path = tmp_path / f"{CONTENT_DB}.db"
    _build_content_db(db_path)
    ds = Datasette(
        files=[str(db_path)],
        memory=True,
        config={"permissions": {"datasette-paper-create": True}},
        settings={"max_post_body_bytes": MAX_STEP_BYTES + 1024 * 1024},
    )
    await ds.invoke_startup()
    return ds


def _client_for(ds: Datasette) -> PaperClient:
    transport = httpx.ASGITransport(app=ds.app())
    cookie = ds.sign({"a": {"id": "alice"}}, "actor")
    return PaperClient(
        base_url="http://testserver",
        transport=transport,
        cookies={"ds_actor": cookie},
    )


@pytest_asyncio.fixture
async def api_client(tmp_path):
    ds = await _build_ds(tmp_path)
    async with _client_for(ds) as client:
        yield client


@pytest.mark.asyncio
# @feat tui: test — run_sql happy path against a real content db
async def test_run_sql_happy_path(api_client):
    result = await datasette_api.run_sql(
        api_client, CONTENT_DB, "select 1 as n, 'hi' as s"
    )
    assert result.ok
    assert result.columns == ["n", "s"]
    assert result.rows == [{"n": 1, "s": "hi"}]


@pytest.mark.asyncio
# @feat tui: test — a Datasette SQL error surfaces as a message, not a crash
async def test_run_sql_error_is_a_message(api_client):
    result = await datasette_api.run_sql(api_client, CONTENT_DB, "select * from nope")
    assert not result.ok
    assert result.rows == []
    assert "nope" in result.error


@pytest.mark.asyncio
async def test_run_sql_accepts_bare_httpx_client(api_client):
    # datasette_api accepts either a PaperClient or its bare ._http.
    result = await datasette_api.run_sql(api_client._http, CONTENT_DB, "select 1 as n")
    assert result.ok
    assert result.rows == [{"n": 1}]


@pytest.mark.asyncio
# @feat tui: test — table_rows pages via _next
async def test_table_rows_pagination(api_client):
    page1 = await datasette_api.table_rows(api_client, CONTENT_DB, "items", size=10)
    assert page1.ok
    assert len(page1.rows) == 10
    assert page1.count == 25
    assert page1.count_truncated is False
    assert page1.next_token is not None
    assert page1.primary_keys == ["id"]

    page2 = await datasette_api.table_rows(
        api_client, CONTENT_DB, "items", size=10, next_token=page1.next_token
    )
    assert page2.ok
    assert len(page2.rows) == 10
    ids1 = {r["id"] for r in page1.rows}
    ids2 = {r["id"] for r in page2.rows}
    assert ids1.isdisjoint(ids2)


@pytest.mark.asyncio
async def test_table_rows_blob_column_is_a_base64_envelope(api_client):
    result = await datasette_api.table_rows(api_client, CONTENT_DB, "items", size=1)
    assert result.ok
    assert result.rows[0]["blob_col"] == {
        "$base64": True,
        "encoded": base64.b64encode(BLOB_BYTES).decode(),
    }


@pytest.mark.asyncio
async def test_table_rows_missing_table_is_an_error(api_client):
    result = await datasette_api.table_rows(api_client, CONTENT_DB, "nope")
    assert not result.ok
    assert result.error


@pytest.mark.asyncio
# @feat tui: test — list_databases / list_tables skip hidden dbs and paper-internal tables
async def test_list_databases_and_tables(api_client):
    dbs = await datasette_api.list_databases(api_client)
    names = {d.name for d in dbs}
    assert CONTENT_DB in names
    assert not any(n.startswith("_") for n in names)

    tables = await datasette_api.list_tables(api_client, CONTENT_DB)
    by_name = {t.name: t for t in tables}
    assert by_name["items"].kind == "table"
    assert by_name["items"].count == 25
    assert by_name["items_view"].kind == "view"


@pytest.mark.asyncio
async def test_list_tables_missing_db_is_an_error(api_client):
    result = await datasette_api.list_tables(api_client, "nope")
    assert isinstance(result, datasette_api.ApiError)


@pytest.mark.asyncio
# @feat tui: test — fetch_row returns one row's field:value pairs
async def test_fetch_row(api_client):
    result = await datasette_api.fetch_row(api_client, CONTENT_DB, "items", "2")
    assert result == [
        {"column": "id", "value": 2},
        {"column": "name", "value": "item1"},
        {"column": "note", "value": "n" * 200},
        {"column": "blob_col", "value": None},
    ]


@pytest.mark.asyncio
async def test_fetch_row_missing_pk_is_an_error(api_client):
    result = await datasette_api.fetch_row(api_client, CONTENT_DB, "items", "9999")
    assert isinstance(result, datasette_api.ApiError)
