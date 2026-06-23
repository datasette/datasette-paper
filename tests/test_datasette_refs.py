"""Tests for the datasette resolve / search / embed endpoints.

These exercise the per-actor permission discipline: a viewer without
``view-table`` on a resource must get ``denied`` with NO label or row data
leaked. ``alice`` is granted the restricted ``secret`` table via an allow
block; ``bob`` is not.
"""

import pytest
from datasette.app import Datasette


# Named in-memory databases share their backing across Datasette instances in
# the same process, so each test gets a unique memory backing mounted under the
# stable logical name `data`.
_DB_SEQ = [0]


async def _make_ds():
    _DB_SEQ[0] += 1
    ds = Datasette(
        memory=True,
        config={
            "permissions": {"datasette-paper-create": True},
            "databases": {"data": {"tables": {"secret": {"allow": {"id": "alice"}}}}},
        },
    )
    db = ds.add_memory_database(f"data_{_DB_SEQ[0]}", name="data")
    await db.execute_write("create table vendors (id integer primary key, name text)")
    await db.execute_write_many(
        "insert into vendors (id, name) values (?, ?)",
        [(i, f"Vendor {i}") for i in range(1, 31)],
    )
    await db.execute_write("create table secret (id integer primary key, code text)")
    await db.execute_write("insert into secret (id, code) values (1, 'xyz')")
    await db.execute_write("create view vendor_names as select name from vendors")
    # A plugin-style table in a user DB — must be excluded from search even
    # though it doesn't live in the internal database.
    await db.execute_write(
        "create table _datasette_paper_fake (id integer primary key)"
    )
    await ds.invoke_startup()
    return ds


def _cookies(ds, actor_id):
    return {"ds_actor": ds.sign({"a": {"id": actor_id}}, "actor")}


async def _resolve(ds, actor_id, refs):
    r = await ds.client.post(
        "/-/paper/api/datasette/resolve",
        json={"refs": refs},
        cookies=_cookies(ds, actor_id),
    )
    assert r.status_code == 200
    return r.json()["refs"]


# ---------------------------------------------------------------------------
# resolve
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_table_row_and_database():
    ds = await _make_ds()
    refs = await _resolve(ds, "alice", ["/data", "/data/vendors", "/data/vendors/1"])
    assert refs["/data"] == {
        "status": "ok",
        "kind": "database",
        "label": "data",
        "db": "data",
        "href": "/data",
    }
    assert refs["/data/vendors"]["status"] == "ok"
    assert refs["/data/vendors"]["kind"] == "table"
    assert refs["/data/vendors"]["count"] == 30
    assert refs["/data/vendors/1"]["status"] == "ok"
    assert refs["/data/vendors/1"]["kind"] == "row"
    # Label comes from the table's label column (name), not the pk.
    assert refs["/data/vendors/1"]["label"] == "Vendor 1"
    # Path identity pieces let the client render db/table/pk.
    assert refs["/data/vendors/1"]["table"] == "vendors"
    assert refs["/data/vendors/1"]["pk"] == "1"


@pytest.mark.asyncio
async def test_resolve_view_flagged_as_view():
    ds = await _make_ds()
    refs = await _resolve(ds, "alice", ["/data/vendor_names"])
    assert refs["/data/vendor_names"]["status"] == "ok"
    assert refs["/data/vendor_names"]["kind"] == "view"


@pytest.mark.asyncio
async def test_resolve_denied_carries_no_label():
    ds = await _make_ds()
    refs = await _resolve(ds, "bob", ["/data/secret", "/data/secret/1"])
    for key in ("/data/secret", "/data/secret/1"):
        assert refs[key] == {"status": "denied"}, refs[key]
        # No label / db / data leaked.
        assert "label" not in refs[key]
        assert "db" not in refs[key]


@pytest.mark.asyncio
async def test_resolve_not_found_carries_no_label():
    ds = await _make_ds()
    refs = await _resolve(ds, "alice", ["/data/nope", "/data/vendors/9999", "/nodb"])
    assert refs["/data/nope"] == {"status": "not_found"}
    assert refs["/data/vendors/9999"] == {"status": "not_found"}
    assert refs["/nodb"] == {"status": "not_found"}


@pytest.mark.asyncio
async def test_resolve_caps_ref_count():
    ds = await _make_ds()
    refs = await _resolve(ds, "alice", ["/data/vendors"] * 250)
    # Capped at MAX_RESOLVE_REFS (100) — deduped to one key here.
    assert "/data/vendors" in refs


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------


async def _search(ds, actor_id, q="", limit=20):
    r = await ds.client.get(
        f"/-/paper/api/datasette/search?q={q}&limit={limit}",
        cookies=_cookies(ds, actor_id),
    )
    assert r.status_code == 200
    return r.json()["results"]


@pytest.mark.asyncio
async def test_search_filters_by_permission():
    ds = await _make_ds()
    alice_refs = {r["ref"] for r in await _search(ds, "alice")}
    bob_refs = {r["ref"] for r in await _search(ds, "bob")}
    assert "/data/secret" in alice_refs
    assert "/data/secret" not in bob_refs


@pytest.mark.asyncio
async def test_search_excludes_internal_and_paper_tables():
    ds = await _make_ds()
    results = await _search(ds, "alice")
    for r in results:
        assert r["db"] != "__INTERNAL__"
        assert not r["label"].startswith("_datasette_paper_")
    # The internal DB's paper tables never appear.
    assert all("_datasette_paper_fake" != r["label"] for r in results)


@pytest.mark.asyncio
async def test_search_prefix_ordering_and_query():
    ds = await _make_ds()
    results = await _search(ds, "alice", q="vendor")
    labels = [r["label"] for r in results]
    # Only name-matching resources, prefix matches first.
    assert labels == ["vendor_names", "vendors"]
    assert all("vendor" in label for label in labels)


# ---------------------------------------------------------------------------
# embed
# ---------------------------------------------------------------------------


async def _embed(ds, actor_id, ref, limit=None):
    url = f"/-/paper/api/datasette/embed?ref={ref}"
    if limit is not None:
        url += f"&limit={limit}"
    r = await ds.client.get(url, cookies=_cookies(ds, actor_id))
    assert r.status_code == 200
    return r.json()


@pytest.mark.asyncio
async def test_embed_table_caps_rows_and_reports_truncation():
    ds = await _make_ds()
    payload = await _embed(ds, "alice", "/data/vendors", limit=10)
    assert payload["status"] == "ok"
    assert payload["kind"] == "table"
    assert payload["columns"] == ["id", "name"]
    assert len(payload["rows"]) == 10
    assert payload["truncated"] is True
    assert payload["count"] == 30


@pytest.mark.asyncio
async def test_embed_table_not_truncated_when_under_cap():
    ds = await _make_ds()
    payload = await _embed(ds, "alice", "/data/vendors", limit=100)
    assert len(payload["rows"]) == 30
    assert payload["truncated"] is False


@pytest.mark.asyncio
async def test_embed_row_returns_fields():
    ds = await _make_ds()
    payload = await _embed(ds, "alice", "/data/vendors/1")
    assert payload["status"] == "ok"
    assert payload["kind"] == "row"
    assert payload["table"] == "vendors"
    assert payload["pk"] == "1"
    assert payload["fields"] == [
        {"column": "id", "value": 1},
        {"column": "name", "value": "Vendor 1"},
    ]


@pytest.mark.asyncio
async def test_embed_database_lists_visible_tables():
    ds = await _make_ds()
    payload = await _embed(ds, "alice", "/data")
    assert payload["status"] == "ok"
    assert payload["kind"] == "database"
    assert payload["db"] == "data"
    by_name = {t["name"]: t for t in payload["tables"]}
    # Plugin-style tables are hidden; real tables/views are listed.
    assert "_datasette_paper_fake" not in by_name
    assert by_name["vendors"]["kind"] == "table"
    assert by_name["vendors"]["count"] == 30
    assert by_name["vendors"]["ref"] == "/data/vendors"
    assert by_name["vendor_names"]["kind"] == "view"
    # Views get no row count (no cheap metadata).
    assert "count" not in by_name["vendor_names"]
    # alice can see the restricted table.
    assert "secret" in by_name


@pytest.mark.asyncio
async def test_embed_database_filters_by_permission():
    ds = await _make_ds()
    payload = await _embed(ds, "bob", "/data")
    assert payload["status"] == "ok"
    assert payload["kind"] == "database"
    names = {t["name"] for t in payload["tables"]}
    assert "secret" not in names
    assert "vendors" in names


@pytest.mark.asyncio
async def test_search_includes_database():
    ds = await _make_ds()
    results = await _search(ds, "alice", q="data")
    db_results = [r for r in results if r["kind"] == "database"]
    assert db_results and db_results[0]["ref"] == "/data"


@pytest.mark.asyncio
async def test_embed_denied_carries_no_data():
    ds = await _make_ds()
    payload = await _embed(ds, "bob", "/data/secret")
    assert payload == {"status": "denied"}
    assert "rows" not in payload and "columns" not in payload


@pytest.mark.asyncio
async def test_embed_not_found_carries_no_data():
    ds = await _make_ds()
    payload = await _embed(ds, "alice", "/data/nope")
    assert payload == {"status": "not_found"}
