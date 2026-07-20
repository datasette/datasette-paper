"""Tests for `datasette paper check`.

Like `test_cli_export.py`, these boot a real file-backed Datasette (via
`tests/_cli.py`'s shared helpers) so the CLI reads from an actual internal
database file with no server running. Corruption cases reuse the
`_mutated_copy` recipes from the export tests.
"""

# @feat cli-check: CLI tests for `paper check` (file-backed internal db)

import pytest

from _cli import append as _append
from _cli import create_doc_with_content as _create_doc_with_content
from _cli import file_backed_ds
from _cli import mutated_copy as _mutated_copy
from _cli import run_cli
from datasette_paper.db import PaperDB
from datasette_paper.instance import get_registry


def _run_check(db_path, *extra):
    return run_cli("paper", "check", db_path, *extra)


@pytest.mark.asyncio
async def test_check_clean_db_all_ok(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    doc_ids = [await _create_doc_with_content(ds, name=f"Doc{i}") for i in range(3)]

    result = _run_check(internal)
    assert result.exit_code == 0, result.output
    for doc_id in doc_ids:
        assert f"ok {doc_id} Doc" in result.output
    assert "(version " in result.output
    assert "checked 3 docs, 0 failed" in result.output


@pytest.mark.asyncio
async def test_check_covers_every_state_and_kind(tmp_path):
    """Archived, trashed, and template docs are all swept — integrity is
    state-independent and trashed docs still get restored."""
    ds, internal = await file_backed_ds(tmp_path)
    archived_id = await _create_doc_with_content(ds, name="Shelved")
    trashed_id = await _create_doc_with_content(ds, name="Binned")
    resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Tmpl", "kind": "template"}
    )
    assert resp.status_code == 201, resp.text
    template_id = resp.json()["id"]
    assert (
        await ds.client.post(f"/-/paper/api/docs/{archived_id}/archive")
    ).status_code == 200
    assert (
        await ds.client.post(f"/-/paper/api/docs/{trashed_id}/trash")
    ).status_code == 200

    result = _run_check(internal)
    assert result.exit_code == 0, result.output
    for doc_id, name in [
        (archived_id, "Shelved"),
        (trashed_id, "Binned"),
        (template_id, "Tmpl"),
    ]:
        assert f"ok {doc_id} {name}" in result.output
    assert "checked 3 docs, 0 failed" in result.output


@pytest.mark.asyncio
async def test_check_reports_gap_and_continues(tmp_path):
    """One doc with a history gap: FAIL with the real message, others ok, exit 1."""
    ds, internal = await file_backed_ds(tmp_path)
    good_id = await _create_doc_with_content(ds, name="Good")
    bad_id = await _create_doc_with_content(ds, name="Bad")
    await _append(ds, bad_id, "More.\n")
    await _append(ds, bad_id, "Even more.\n")
    copy = _mutated_copy(
        internal,
        tmp_path,
        "gap.db",
        (
            "DELETE FROM _datasette_paper_step WHERE doc_id = ? AND version = 2",
            [bad_id],
        ),
    )

    result = _run_check(copy)
    assert result.exit_code == 1, result.output
    assert f"ok {good_id} Good" in result.output
    assert f"FAIL {bad_id} Bad:" in result.output
    assert "not contiguous" in result.output
    assert "checked 2 docs, 1 failed" in result.output


@pytest.mark.asyncio
async def test_check_reports_truncated_tail(tmp_path):
    """Doc row says version N but the last step row is gone → FAIL."""
    ds, internal = await file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds, name="Chopped")
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

    result = _run_check(copy)
    assert result.exit_code == 1, result.output
    assert f"FAIL {doc_id} Chopped:" in result.output
    assert "Incomplete step history" in result.output


@pytest.mark.asyncio
async def test_check_reports_corrupt_snapshot(tmp_path):
    """Corrupt snapshot planted at current_version → materialization FAILs."""
    ds, internal = await file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds, name="Snappy")
    db = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    inst = await registry.get(db, doc_id)
    # Plant at exactly current_version so the terminal check passes and
    # snapshot parsing is what fails (recipe from test_cli_export.py).
    await db.insert_snapshot(
        doc_id=doc_id, version=inst.version, doc_json="{not json", actor_id=None
    )

    result = _run_check(internal)
    assert result.exit_code == 1, result.output
    assert f"FAIL {doc_id} Snappy:" in result.output
    assert f"Snapshot at version {inst.version} failed to parse" in result.output


@pytest.mark.asyncio
async def test_check_doc_id_narrows_to_one_doc(tmp_path):
    """--doc-id on the bad doc → exit 1; on a good doc in the same file → 0."""
    ds, internal = await file_backed_ds(tmp_path)
    good_id = await _create_doc_with_content(ds, name="Good")
    bad_id = await _create_doc_with_content(ds, name="Bad")
    await _append(ds, bad_id, "More.\n")
    copy = _mutated_copy(
        internal,
        tmp_path,
        "onebad.db",
        (
            "DELETE FROM _datasette_paper_step WHERE doc_id = ? AND version = 1",
            [bad_id],
        ),
    )

    bad_result = _run_check(copy, "--doc-id", str(bad_id))
    assert bad_result.exit_code == 1, bad_result.output
    assert f"FAIL {bad_id} Bad:" in bad_result.output
    assert "checked 1 docs, 1 failed" in bad_result.output

    good_result = _run_check(copy, "--doc-id", str(good_id))
    assert good_result.exit_code == 0, good_result.output
    assert f"ok {good_id} Good" in good_result.output
    assert "checked 1 docs, 0 failed" in good_result.output
