"""Tests for `datasette paper export` (the CLI) and its export.py API.

The CLI reads a doc from an internal database *file* with no server
running, so these boot a real file-backed Datasette (unlike the shared
in-memory fixtures), write content through the normal append pipeline,
then export from the file — exercising the standalone snapshot +
step-tail fold end to end. History-integrity cases (gaps, truncated
tails, corrupt rows) are produced by mutating a *copy* of the seeded
file with a raw sqlite3 connection, so the live Datasette never fights
the mutation for locks.
"""

# @feat cli-export: CLI + export.py API tests (file-backed internal db)

import json
import sqlite3

import pytest

from _cli import DEFAULT_CONTENT_MD as CONTENT_MD
from _cli import append as _append
from _cli import create_doc_with_content as _create_doc_with_content
from _cli import document_markdown as _document_markdown
from _cli import file_backed_ds as _file_backed_ds
from _cli import mutated_copy as _mutated_copy
from _cli import run_cli
from _cli import snapshot_at_current_version as _snapshot_at_current_version
from datasette_paper.db import PaperDB
from datasette_paper.export import (
    ExportError,
    export_markdown,
    load_live_doc,
    open_internal_db,
)
from datasette_paper.instance import get_registry
from datasette_paper.sql import _queries

# A new doc holds one empty paragraph; append adds content after it, so the
# exported markdown leads with the empty paragraph's blank line (same as the
# /document endpoint — doc_to_markdown only rstrips).
EXPORTED_MD = "\n\n" + CONTENT_MD


def _run_export(db_path, doc_id, *extra):
    return run_cli("paper", "export", db_path, str(doc_id), *extra)


# ── happy paths ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cli_exports_markdown(tmp_path):
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)

    result = _run_export(internal, doc_id)
    assert result.exit_code == 0, result.output
    assert result.output == EXPORTED_MD


@pytest.mark.asyncio
async def test_cli_matches_document_endpoint(tmp_path):
    """The CLI and the /document API produce the same markdown."""
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)

    expected = await _document_markdown(ds, doc_id)
    result = _run_export(internal, doc_id)
    assert result.exit_code == 0
    assert result.output == expected


@pytest.mark.asyncio
async def test_cli_exports_snapshot_plus_tail(tmp_path):
    """A doc whose history is a real snapshot + later steps exports fully."""
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds, "Before the snapshot.\n")
    version = await _snapshot_at_current_version(ds, doc_id)
    assert version > 0
    await _append(ds, doc_id, "After the snapshot.\n")

    result = _run_export(internal, doc_id)
    assert result.exit_code == 0, result.output
    assert "Before the snapshot." in result.output
    assert "After the snapshot." in result.output
    assert result.output == await _document_markdown(ds, doc_id)


@pytest.mark.asyncio
async def test_cli_format_flag(tmp_path):
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)

    default = _run_export(internal, doc_id)
    explicit = _run_export(internal, doc_id, "-f", "markdown")
    assert explicit.exit_code == 0
    assert explicit.output == default.output

    unsupported = _run_export(internal, doc_id, "-f", "json")
    assert unsupported.exit_code == 2  # click usage error, before any db work
    assert "Invalid value" in unsupported.output


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name", ["with space.db", "hash#name.db", "pct%name.db", "quest?ion.db"]
)
async def test_cli_handles_uri_hostile_filenames(tmp_path, name):
    """`?`, `#`, `%`, spaces in the db filename must not break the ro URI."""
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    copy = _mutated_copy(internal, tmp_path, name)

    result = _run_export(copy, doc_id)
    assert result.exit_code == 0, result.output
    assert result.output == EXPORTED_MD


@pytest.mark.asyncio
async def test_export_api_direct_and_read_only(tmp_path):
    """export.py works as a plain Python API, and the connection can't write."""
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)

    conn = open_internal_db(internal)
    try:
        assert export_markdown(conn, doc_id) == EXPORTED_MD
        doc = load_live_doc(conn, doc_id)
        assert doc["type"] == "doc"
        with pytest.raises(ExportError, match="No paper doc with id 12345"):
            load_live_doc(conn, 12345)
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            conn.execute("DELETE FROM _datasette_paper_step")
    finally:
        conn.close()


# ── history integrity: fail closed, name real versions ──────────────────────


def _assert_clean_failure(result, *fragments):
    """Exit 1, the message names each fragment, and no markdown leaked."""
    assert result.exit_code == 1, result.output
    for fragment in fragments:
        assert fragment in result.output, result.output
    assert "# Title" not in result.output


@pytest.mark.asyncio
async def test_gap_in_step_history_fails(tmp_path):
    """Snapshot at 0, steps 1..N with 2 deleted → contiguity error names 2/3."""
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    await _append(ds, doc_id, "More.\n")
    await _append(ds, doc_id, "Even more.\n")
    copy = _mutated_copy(
        internal,
        tmp_path,
        "gap.db",
        (
            "DELETE FROM _datasette_paper_step WHERE doc_id = ? AND version = 2",
            [doc_id],
        ),
    )

    result = _run_export(copy, doc_id)
    _assert_clean_failure(
        result, "not contiguous", "expected version 2", "found version 3"
    )


@pytest.mark.asyncio
async def test_missing_first_step_without_snapshot_fails(tmp_path):
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    await _append(ds, doc_id, "More.\n")
    copy = _mutated_copy(
        internal,
        tmp_path,
        "nofirst.db",
        (
            "DELETE FROM _datasette_paper_step WHERE doc_id = ? AND version = 1",
            [doc_id],
        ),
    )

    result = _run_export(copy, doc_id)
    _assert_clean_failure(
        result, "not contiguous", "expected version 1", "found version 2"
    )


@pytest.mark.asyncio
async def test_truncated_tail_fails(tmp_path):
    """Doc row says version N but the last step row is gone → fail closed."""
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    await _append(ds, doc_id, "More.\n")
    copy = _mutated_copy(
        internal,
        tmp_path,
        "truncated.db",
        (
            "DELETE FROM _datasette_paper_step WHERE doc_id = ? AND version ="
            " (SELECT MAX(version) FROM _datasette_paper_step WHERE doc_id = ?)",
            [doc_id, doc_id],
        ),
    )

    result = _run_export(copy, doc_id)
    _assert_clean_failure(result, "Incomplete step history")


@pytest.mark.asyncio
async def test_corrupt_step_error_names_stored_version(tmp_path):
    """Snapshot at K>0 + corrupt step K+1 → error says K+1, not ordinal 1."""
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    snapshot_version = await _snapshot_at_current_version(ds, doc_id)
    await _append(ds, doc_id, "After.\n")
    bad_version = snapshot_version + 1
    copy = _mutated_copy(
        internal,
        tmp_path,
        "corrupt-step.db",
        (
            "UPDATE _datasette_paper_step SET step_json = '{not json'"
            " WHERE doc_id = ? AND version = ?",
            [doc_id, bad_version],
        ),
    )

    result = _run_export(copy, doc_id)
    _assert_clean_failure(result, f"Step version {bad_version} raised")
    assert "Step version 1 " not in result.output


@pytest.mark.asyncio
async def test_unknown_step_type_fails(tmp_path):
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    snapshot_version = await _snapshot_at_current_version(ds, doc_id)
    await _append(ds, doc_id, "After.\n")
    bad_version = snapshot_version + 1
    copy = _mutated_copy(
        internal,
        tmp_path,
        "unknown-step.db",
        (
            "UPDATE _datasette_paper_step SET step_json ="
            ' \'{"stepType": "bogus"}\' WHERE doc_id = ? AND version = ?',
            [doc_id, bad_version],
        ),
    )

    result = _run_export(copy, doc_id)
    _assert_clean_failure(result, f"Step version {bad_version} raised")


@pytest.mark.asyncio
async def test_step_apply_failure_fails(tmp_path):
    """A structurally valid step that can't apply (out-of-range) fails closed."""
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    snapshot_version = await _snapshot_at_current_version(ds, doc_id)
    await _append(ds, doc_id, "After.\n")
    bad_version = snapshot_version + 1
    copy = _mutated_copy(
        internal,
        tmp_path,
        "bad-apply.db",
        (
            "UPDATE _datasette_paper_step SET step_json ="
            ' \'{"stepType": "replace", "from": 99999, "to": 99999}\''
            " WHERE doc_id = ? AND version = ?",
            [doc_id, bad_version],
        ),
    )

    result = _run_export(copy, doc_id)
    _assert_clean_failure(result, f"Step version {bad_version}")


@pytest.mark.asyncio
async def test_corrupt_snapshot_json_fails(tmp_path):
    """The latest snapshot fails to parse → clean error, no markdown."""
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    db = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    inst = await registry.get(db, doc_id)
    # Plant the corrupt snapshot at exactly current_version so the terminal
    # check passes and materialization is what fails.
    await db.insert_snapshot(
        doc_id=doc_id, version=inst.version, doc_json="{not json", actor_id=None
    )

    result = _run_export(internal, doc_id)
    _assert_clean_failure(result, f"Snapshot at version {inst.version} failed to parse")


# ── concurrency: one consistent read snapshot (compaction race) ─────────────


@pytest.mark.asyncio
async def test_export_is_consistent_under_concurrent_compaction(tmp_path, monkeypatch):
    """Deterministic replay of the compaction race.

    Arrange no snapshot + a non-empty step tail. Pause export right after
    it selects the (absent) latest snapshot, run a writer that compacts the
    doc — inserts a snapshot at current_version and deletes every folded
    step — then resume. Export's read transaction must keep observing the
    pre-compaction state and emit the complete document. (Without the BEGIN
    in load_live_doc, the step query would see the emptied table and the
    doc would export stale — caught then only by the terminal-version
    check.) WAL mode is required so the writer can commit while the read
    transaction is open.
    """
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    await _append(ds, doc_id, "Tail edit.\n")
    expected = await _document_markdown(ds, doc_id)

    db = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    inst = await registry.get(db, doc_id)
    live_json = json.dumps(inst.materialize_live_doc())
    current_version = inst.version

    copy = _mutated_copy(internal, tmp_path, "race.db")
    writer = sqlite3.connect(copy, timeout=2)
    assert writer.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"

    compacted = {"done": False}
    real_select_latest_snapshot = _queries.select_latest_snapshot

    def select_then_compact(conn, doc_id):
        result = real_select_latest_snapshot(conn, doc_id=doc_id)
        if not compacted["done"]:
            compacted["done"] = True
            writer.execute(
                "INSERT INTO _datasette_paper_snapshot"
                " (doc_id, version, doc_json, actor_id) VALUES (?, ?, ?, NULL)",
                [doc_id, current_version, live_json],
            )
            writer.execute(
                "DELETE FROM _datasette_paper_step WHERE doc_id = ?", [doc_id]
            )
            writer.commit()
        return result

    monkeypatch.setattr(_queries, "select_latest_snapshot", select_then_compact)

    conn = open_internal_db(copy)
    try:
        md = export_markdown(conn, doc_id)
    finally:
        conn.close()

    assert compacted["done"], "the compaction hook never fired"
    # The writer really did compact — a fresh connection sees no steps.
    assert (
        writer.execute(
            "SELECT COUNT(*) FROM _datasette_paper_step WHERE doc_id = ?", [doc_id]
        ).fetchone()[0]
        == 0
    )
    writer.close()
    # ...but the export saw one coherent pre-compaction state: full content.
    assert md == expected
    assert "Tail edit." in md


# ── wrong or stale files ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cli_missing_doc_errors(tmp_path):
    ds, internal = await _file_backed_ds(tmp_path)

    result = _run_export(internal, 999)
    _assert_clean_failure(result, "No paper doc with id 999")


def test_cli_rejects_non_paper_db(tmp_path):
    stray = tmp_path / "stray.db"
    sqlite3.connect(stray).execute("CREATE TABLE t (x)").connection.close()

    result = _run_export(str(stray), 1)
    _assert_clean_failure(result, "has no paper tables")


def test_cli_reports_schema_mismatch_in_doc_table(tmp_path):
    """A paper doc table from a different plugin era errors, not tracebacks."""
    stale = tmp_path / "stale.db"
    conn = sqlite3.connect(stale)
    conn.execute("CREATE TABLE _datasette_paper_doc (id INTEGER PRIMARY KEY)")
    conn.close()

    result = _run_export(str(stale), 1)
    _assert_clean_failure(result, "schema mismatch")


@pytest.mark.asyncio
async def test_cli_reports_schema_mismatch_in_snapshot_table(tmp_path):
    """Doc table fine, snapshot table missing → still a clean schema error."""
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    copy = _mutated_copy(
        internal, tmp_path, "nosnap.db", ("DROP TABLE _datasette_paper_snapshot", [])
    )

    result = _run_export(copy, doc_id)
    _assert_clean_failure(result, "schema mismatch")


@pytest.mark.asyncio
async def test_cli_reports_schema_mismatch_in_step_table(tmp_path):
    """Doc table fine, step table missing a column → clean schema error."""
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    copy = _mutated_copy(
        internal,
        tmp_path,
        "badstep.db",
        ("DROP TABLE _datasette_paper_step", []),
        ("CREATE TABLE _datasette_paper_step (doc_id INTEGER)", []),
    )

    result = _run_export(copy, doc_id)
    _assert_clean_failure(result, "schema mismatch")
