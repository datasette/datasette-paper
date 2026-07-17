"""Tests for `datasette paper list`.

Like `test_cli_export.py`, these boot a real file-backed Datasette (via
`tests/_cli.py`'s shared helpers) so the CLI reads from an actual internal
database file with no server running.
"""

# @feat cli-list: CLI tests for `paper list` (file-backed internal db)

import json
import sqlite3

import pytest

from _cli import file_backed_ds, run_cli


def _run_list(db_path, *extra):
    return run_cli("paper", "list", db_path, *extra)


async def _create_doc(ds, name):
    resp = await ds.client.post("/-/paper/api/docs", json={"name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_list_shows_all_docs_with_states(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    active_id = await _create_doc(ds, "ActiveDoc")
    archived_id = await _create_doc(ds, "ArchivedDoc")
    trashed_id = await _create_doc(ds, "TrashedDoc")

    assert (
        await ds.client.post(f"/-/paper/api/docs/{archived_id}/archive")
    ).status_code == 200
    assert (
        await ds.client.post(f"/-/paper/api/docs/{trashed_id}/trash")
    ).status_code == 200

    result = _run_list(internal)
    assert result.exit_code == 0, result.output

    lines = result.output.splitlines()
    header = lines[0].split()
    assert header == ["ID", "NAME", "STATE", "KIND", "VERSION", "UPDATED"]

    body = "\n".join(lines[1:])
    assert str(active_id) in body
    assert str(archived_id) in body
    assert str(trashed_id) in body

    by_id = {}
    for line in lines[1:]:
        parts = line.split()
        by_id[parts[0]] = parts

    assert by_id[str(active_id)][2] == "active"
    assert by_id[str(archived_id)][2] == "archived"
    assert by_id[str(trashed_id)][2] == "trashed"


@pytest.mark.asyncio
async def test_list_state_filter(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    active_id = await _create_doc(ds, "ActiveDoc")
    archived_id = await _create_doc(ds, "ArchivedDoc")
    trashed_id = await _create_doc(ds, "TrashedDoc")
    assert (
        await ds.client.post(f"/-/paper/api/docs/{archived_id}/archive")
    ).status_code == 200
    assert (
        await ds.client.post(f"/-/paper/api/docs/{trashed_id}/trash")
    ).status_code == 200

    result = _run_list(internal, "--state", "active")
    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert len(lines) == 2  # header + one row
    row_ids = {line.split()[0] for line in lines[1:]}
    assert row_ids == {str(active_id)}


@pytest.mark.asyncio
async def test_list_state_filter_repeatable(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    active_id = await _create_doc(ds, "ActiveDoc")
    archived_id = await _create_doc(ds, "ArchivedDoc")
    trashed_id = await _create_doc(ds, "TrashedDoc")
    assert (
        await ds.client.post(f"/-/paper/api/docs/{archived_id}/archive")
    ).status_code == 200
    assert (
        await ds.client.post(f"/-/paper/api/docs/{trashed_id}/trash")
    ).status_code == 200

    result = _run_list(internal, "--state", "active", "--state", "archived")
    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    row_ids = {line.split()[0] for line in lines[1:]}
    assert row_ids == {str(active_id), str(archived_id)}


@pytest.mark.asyncio
async def test_list_json_round_trips_ids_and_names(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    a = await _create_doc(ds, "Doc A")
    b = await _create_doc(ds, "Doc B")

    result = _run_list(internal, "--json")
    assert result.exit_code == 0, result.output
    rows = json.loads(result.output)
    assert {row["id"] for row in rows} == {a, b}
    by_id = {row["id"]: row for row in rows}
    assert by_id[a]["name"] == "Doc A"
    assert by_id[b]["name"] == "Doc B"
    # Full doc row — all 13 Doc columns present.
    assert set(by_id[a]) == {
        "id",
        "name",
        "created_at",
        "updated_at",
        "created_by",
        "schema_name",
        "current_version",
        "state",
        "archived_at",
        "trashed_at",
        "delete_at",
        "kind",
        "locked",
    }


@pytest.mark.asyncio
async def test_list_json_state_filter(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    active_id = await _create_doc(ds, "Active Doc")
    trashed_id = await _create_doc(ds, "Trashed Doc")
    assert (
        await ds.client.post(f"/-/paper/api/docs/{trashed_id}/trash")
    ).status_code == 200

    result = _run_list(internal, "--json", "--state", "trashed")
    assert result.exit_code == 0, result.output
    rows = json.loads(result.output)
    assert {row["id"] for row in rows} == {trashed_id}
    assert active_id not in {row["id"] for row in rows}


@pytest.mark.asyncio
async def test_list_empty_db_exits_zero(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)

    result = _run_list(internal)
    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert len(lines) == 1  # header only
    assert lines[0].split() == ["ID", "NAME", "STATE", "KIND", "VERSION", "UPDATED"]


@pytest.mark.asyncio
async def test_list_empty_db_json_exits_zero(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)

    result = _run_list(internal, "--json")
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == []


def test_list_rejects_non_paper_db(tmp_path):
    stray = tmp_path / "stray.db"
    sqlite3.connect(stray).execute("CREATE TABLE t (x)").connection.close()

    result = _run_list(str(stray))
    assert result.exit_code == 1, result.output
    assert "has no paper tables" in result.output
