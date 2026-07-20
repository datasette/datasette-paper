"""Tests for `datasette paper dump`.

Like `test_cli_export.py`, these boot a real file-backed Datasette (via
`tests/_cli.py`'s shared helpers) so the CLI reads from an actual internal
database file with no server running.
"""

# @feat cli-dump: CLI tests for `paper dump` (file-backed internal db)

import pytest

from _cli import append as _append
from _cli import create_doc_with_content as _create_doc_with_content
from _cli import file_backed_ds
from _cli import mutated_copy as _mutated_copy
from _cli import run_cli


def _run_dump(db_path, out_dir, *extra):
    return run_cli("paper", "dump", db_path, str(out_dir), *extra)


@pytest.mark.asyncio
async def test_dump_writes_every_doc_byte_identical_to_export(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    doc_ids = []
    for i in range(3):
        doc_ids.append(
            await _create_doc_with_content(
                ds, content=f"# Doc {i}\n\nBody **{i}**.\n", name=f"Doc{i}"
            )
        )

    out = tmp_path / "out"
    result = _run_dump(internal, out)
    assert result.exit_code == 0, result.output
    assert f"dumped 3 docs to {out}, 0 failed" in result.output

    for i, doc_id in enumerate(doc_ids):
        path = out / f"{doc_id}-doc{i}.md"
        assert path.exists(), sorted(p.name for p in out.iterdir())
        single = run_cli("paper", "export", internal, str(doc_id))
        assert single.exit_code == 0, single.output
        assert path.read_text(encoding="utf-8") == single.output


@pytest.mark.asyncio
async def test_dump_filename_hygiene(tmp_path):
    """Punctuation slugs to `-` runs; an all-punctuation name → bare `<id>.md`."""
    ds, internal = await file_backed_ds(tmp_path)
    weird_id = await _create_doc_with_content(ds, name="  Weird / Name?! ")
    empty_id = await _create_doc_with_content(ds, name="!!!")

    out = tmp_path / "out"
    result = _run_dump(internal, out)
    assert result.exit_code == 0, result.output

    names = {p.name for p in out.iterdir()}
    assert names == {f"{weird_id}-weird-name.md", f"{empty_id}.md"}


@pytest.mark.asyncio
async def test_dump_continues_past_corrupt_doc(tmp_path):
    """A gap in one doc's history: FAILED on stderr, others written, exit 1."""
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

    out = tmp_path / "out"
    result = _run_dump(copy, out)
    assert result.exit_code == 1, result.output
    assert f"FAILED {bad_id} Bad:" in result.stderr
    assert "not contiguous" in result.stderr
    # The good doc still dumped; no partial file for the bad one.
    assert {p.name for p in out.iterdir()} == {f"{good_id}-good.md"}
    assert "dumped 1 docs" in result.output
    assert "1 failed" in result.output


@pytest.mark.asyncio
async def test_dump_state_filter(tmp_path):
    """Default set is active+archived; trashed only with --state trashed."""
    ds, internal = await file_backed_ds(tmp_path)
    active_id = await _create_doc_with_content(ds, name="Lively")
    archived_id = await _create_doc_with_content(ds, name="Shelved")
    trashed_id = await _create_doc_with_content(ds, name="Binned")
    assert (
        await ds.client.post(f"/-/paper/api/docs/{archived_id}/archive")
    ).status_code == 200
    assert (
        await ds.client.post(f"/-/paper/api/docs/{trashed_id}/trash")
    ).status_code == 200

    out = tmp_path / "default"
    assert _run_dump(internal, out).exit_code == 0
    assert {p.name for p in out.iterdir()} == {
        f"{active_id}-lively.md",
        f"{archived_id}-shelved.md",
    }

    out_trashed = tmp_path / "trashed"
    assert _run_dump(internal, out_trashed, "--state", "trashed").exit_code == 0
    assert {p.name for p in out_trashed.iterdir()} == {f"{trashed_id}-binned.md"}


@pytest.mark.asyncio
async def test_dump_creates_out_dir_and_overwrites_on_redump(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds, name="Doc")

    out = tmp_path / "nested" / "out"  # doesn't exist yet
    assert _run_dump(internal, out).exit_code == 0
    path = out / f"{doc_id}-doc.md"
    first = path.read_text(encoding="utf-8")

    await _append(ds, doc_id, "Fresh paragraph.\n")
    assert _run_dump(internal, out).exit_code == 0
    second = path.read_text(encoding="utf-8")
    assert second != first
    assert "Fresh paragraph." in second
