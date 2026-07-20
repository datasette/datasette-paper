"""Tests for `datasette paper info`.

Like `test_cli_export.py`, these boot a real file-backed Datasette (via
`tests/_cli.py`'s shared helpers) so the CLI reads from an actual internal
database file with no server running.

`info` never materializes a doc. The ticket that specified this command
suggested proving it via `"prosemirror" not in sys.modules` after an
in-process run — that check turns out to always fail here, for a reason
unrelated to `info`: `datasette_paper/__init__.py` imports `routes` at
module level, which imports `markdown.py`, which imports `pm_schema.py`
at module level too, so prosemirror-py loads as soon as the plugin does —
before any CLI command body runs, `paper list` included (confirmed: even
a bare `from datasette.cli import cli` in a fresh interpreter imports it,
since building the `paper` command group calls `register_commands` across
every installed plugin). So instead of the unreliable sys.modules check,
`test_info_never_materializes` patches `export.materialize` — the one
function in the export path that actually invokes prosemirror-py — to
blow up if called, and confirms `info` still succeeds. That directly
tests the guarantee that matters: `info`'s own code path never folds the
step tail through prosemirror, even though the module is already loaded
by the time it runs.
"""

# @feat cli-info: CLI tests for `paper info` (file-backed internal db, history stats)

import json
import sqlite3

import pytest

from _cli import append as _append
from _cli import create_doc_with_content as _create_doc_with_content
from _cli import file_backed_ds as _file_backed_ds
from _cli import mutated_copy as _mutated_copy
from _cli import run_cli
from _cli import snapshot_at_current_version as _snapshot_at_current_version


def _run_info(db_path, doc_id, *extra):
    return run_cli("paper", "info", db_path, str(doc_id), *extra)


def _lines_to_dict(output):
    report = {}
    for line in output.splitlines():
        if line.startswith("WARNING"):
            continue
        key, _, value = line.partition(": ")
        report[key] = value
    return report


@pytest.mark.asyncio
async def test_info_fresh_doc_two_appends(tmp_path):
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)  # one append -> version 1
    await _append(ds, doc_id, "Second.\n")  # -> version 2

    result = _run_info(internal, doc_id)
    assert result.exit_code == 0, result.output
    report = _lines_to_dict(result.output)
    assert report["version"] == "2"
    assert report["snapshot"] == "none"
    assert report["tail steps"] == "2"
    assert report["total steps"] == "2"
    assert report["total snapshots"] == "0"
    assert "WARNING" not in result.output


@pytest.mark.asyncio
async def test_info_after_snapshot_and_append(tmp_path):
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    await _append(ds, doc_id, "Second.\n")
    snapshot_version = await _snapshot_at_current_version(ds, doc_id)
    assert snapshot_version == 2
    await _append(ds, doc_id, "Third.\n")  # -> version 3, one step past snapshot

    result = _run_info(internal, doc_id)
    assert result.exit_code == 0, result.output
    report = _lines_to_dict(result.output)
    assert report["version"] == "3"
    assert report["snapshot"].startswith(f"version {snapshot_version} ")
    assert report["tail steps"] == "1"
    # Totals include both the folded and live steps (2 pre-snapshot + 1
    # post-snapshot) and the one planted snapshot row.
    assert report["total steps"] == "3"
    assert report["total snapshots"] == "1"
    assert "WARNING" not in result.output


@pytest.mark.asyncio
async def test_info_truncated_tail_warns_but_exits_zero(tmp_path):
    """info is diagnostic, not fail-closed: a truncated tail warns, doesn't raise."""
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    await _append(ds, doc_id, "Second.\n")
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

    result = _run_info(copy, doc_id)
    assert result.exit_code == 0, result.output
    assert "WARNING" in result.output
    assert "incomplete history" in result.output.lower()
    assert "paper check" in result.output


@pytest.mark.asyncio
async def test_info_json_round_trips_stats(tmp_path):
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    await _append(ds, doc_id, "Second.\n")

    result = _run_info(internal, doc_id, "--json")
    assert result.exit_code == 0, result.output
    report = json.loads(result.output)
    assert report["id"] == doc_id
    assert report["current_version"] == 2
    assert report["snapshot_version"] is None
    assert report["tail_steps"] == 2
    assert report["total_steps"] == 2
    assert report["total_snapshots"] == 0
    assert report["incomplete_history"] is False


@pytest.mark.asyncio
async def test_info_missing_doc_errors(tmp_path):
    ds, internal = await _file_backed_ds(tmp_path)

    result = _run_info(internal, 999)
    assert result.exit_code == 1, result.output
    assert "No paper doc with id 999" in result.output


def test_info_rejects_non_paper_db(tmp_path):
    stray = tmp_path / "stray.db"
    sqlite3.connect(stray).execute("CREATE TABLE t (x)").connection.close()

    result = _run_info(str(stray), 1)
    assert result.exit_code == 1, result.output
    assert "has no paper tables" in result.output


@pytest.mark.asyncio
async def test_info_never_materializes(tmp_path, monkeypatch):
    """`info` must not fold the step tail through prosemirror-py.

    See the module docstring for why this doesn't check
    `sys.modules` — patch the one function in `export.py` that actually
    invokes prosemirror-py and confirm `info` runs clean without ever
    reaching it.
    """
    ds, internal = await _file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds)
    await _append(ds, doc_id, "Second.\n")

    from datasette_paper import export

    def _boom(*args, **kwargs):
        raise AssertionError("info must not materialize a doc")

    monkeypatch.setattr(export, "materialize", _boom)

    result = _run_info(internal, doc_id)
    assert result.exit_code == 0, result.output
