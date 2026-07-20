"""Tests for `datasette paper tasks`.

Like `test_cli_export.py`, these boot a real file-backed Datasette (via
`tests/_cli.py`'s shared helpers) so the CLI reads from an actual internal
database file with no server running.
"""

# @feat cli-tasks: CLI tests for `paper tasks` (file-backed internal db)

import json

import pytest

from _cli import append as _append
from _cli import create_doc_with_content as _create_doc_with_content
from _cli import file_backed_ds
from _cli import mutated_copy as _mutated_copy
from _cli import run_cli


def _run_tasks(db_path, *extra):
    return run_cli("paper", "tasks", db_path, *extra)


NESTED_TWO_HEADINGS_MD = (
    "## Sprint 1\n\n"
    "- [ ] parent task\n"
    "  - [x] child task\n\n"
    "## Sprint 2\n\n"
    "- [ ] solo task\n"
)

SMALL_NESTED_MD = "- [ ] parent\n  - [ ] child open\n  - [x] child done\n"


# ── single doc: JSON ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_json_single_doc_nested_under_two_headings(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds, NESTED_TWO_HEADINGS_MD)

    result = _run_tasks(internal, str(doc_id))
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)

    assert [t["text"] for t in payload] == ["parent task", "child task", "solo task"]
    assert [t["checked"] for t in payload] == [False, True, False]

    parent, child, solo = payload
    assert parent["depth"] == 1
    assert child["depth"] == 3
    assert solo["depth"] == 1

    assert parent["section"] == [{"level": 2, "text": "Sprint 1"}]
    assert child["section"] == [{"level": 2, "text": "Sprint 1"}]
    assert solo["section"] == [{"level": 2, "text": "Sprint 2"}]


@pytest.mark.asyncio
async def test_json_is_default_format(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds, NESTED_TWO_HEADINGS_MD)

    default = _run_tasks(internal, str(doc_id))
    explicit = _run_tasks(internal, str(doc_id), "-f", "json")
    assert default.exit_code == explicit.exit_code == 0
    assert default.output == explicit.output


# ── single doc: parity with GET /tasks ──────────────────────────────────────


@pytest.mark.asyncio
async def test_json_matches_tasks_endpoint(tmp_path):
    """The CLI's JSON output equals the `tasks` list the /tasks API returns."""
    ds, internal = await file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds, NESTED_TWO_HEADINGS_MD)

    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tasks")
    assert resp.status_code == 200, resp.text
    expected = resp.json()["tasks"]

    result = _run_tasks(internal, str(doc_id))
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == expected


# ── single doc: markdown ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_markdown_checklist_exact_nested_output(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds, SMALL_NESTED_MD)

    result = _run_tasks(internal, str(doc_id), "-f", "markdown")
    assert result.exit_code == 0, result.output
    assert result.output == (
        "  - [ ] parent\n      - [ ] child open\n      - [x] child done\n"
    )


@pytest.mark.asyncio
async def test_markdown_no_tasks_is_empty(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)
    doc_id = await _create_doc_with_content(ds, "# Title\n\nJust prose.\n")

    result = _run_tasks(internal, str(doc_id), "-f", "markdown")
    assert result.exit_code == 0, result.output
    assert result.output == ""


# ── instance-wide sweep ──────────────────────────────────────────────────────


async def _create_doc(ds, name):
    resp = await ds.client.post("/-/paper/api/docs", json={"name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_sweep_groups_orders_and_excludes_empty_and_archived(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)

    doc_a = await _create_doc(ds, "Doc A")
    await _append(ds, doc_a, "- [ ] a task\n")

    doc_empty = await _create_doc(ds, "Doc Empty")
    await _append(ds, doc_empty, "Just prose, no tasks.\n")

    doc_b = await _create_doc(ds, "Doc B")
    await _append(ds, doc_b, "- [ ] b task\n- [x] b task done\n")

    doc_archived = await _create_doc(ds, "Doc Archived")
    await _append(ds, doc_archived, "- [ ] archived task\n")
    assert (
        await ds.client.post(f"/-/paper/api/docs/{doc_archived}/archive")
    ).status_code == 200

    # JSON: grouped per doc, list_docs (created_at) order, empty/archived gone.
    result = _run_tasks(internal)
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert [entry["doc_id"] for entry in payload] == [doc_a, doc_b]
    assert [entry["doc_name"] for entry in payload] == ["Doc A", "Doc B"]
    assert [t["text"] for t in payload[0]["tasks"]] == ["a task"]
    assert [t["text"] for t in payload[1]["tasks"]] == ["b task", "b task done"]

    # Markdown: `## <doc name>` headings, same ordering/exclusions.
    md_result = _run_tasks(internal, "-f", "markdown")
    assert md_result.exit_code == 0, md_result.output
    assert md_result.output == (
        "## Doc A\n\n"
        "  - [ ] a task\n"
        "\n"
        "## Doc B\n\n"
        "  - [ ] b task\n"
        "  - [x] b task done\n"
    )
    assert "Doc Empty" not in md_result.output
    assert "Doc Archived" not in md_result.output


@pytest.mark.asyncio
async def test_sweep_empty_instance_json_is_empty_list(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)

    result = _run_tasks(internal)
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == []


@pytest.mark.asyncio
async def test_sweep_empty_instance_markdown_is_empty(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)

    result = _run_tasks(internal, "-f", "markdown")
    assert result.exit_code == 0, result.output
    assert result.output == ""


# ── fail closed on corrupt history ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_sweep_corrupt_doc_fails_closed_and_names_the_doc(tmp_path):
    """A corrupt doc in the sweep aborts the whole run naming the doc."""
    ds, internal = await file_backed_ds(tmp_path)

    doc_a = await _create_doc(ds, "Doc A")
    await _append(ds, doc_a, "- [ ] a task\n")

    doc_broken = await _create_doc(ds, "Doc Broken")
    await _append(ds, doc_broken, "- [ ] one\n")
    await _append(ds, doc_broken, "- [ ] two\n")

    copy = _mutated_copy(
        internal,
        tmp_path,
        "corrupt-sweep.db",
        (
            "DELETE FROM _datasette_paper_step WHERE doc_id = ? AND version = 2",
            [doc_broken],
        ),
    )

    result = _run_tasks(copy)
    assert result.exit_code == 1, result.output
    assert f"doc {doc_broken}" in result.output
    assert "Doc Broken" in result.output
    assert "Incomplete step history" in result.output
    # The doc before the broken one never leaked partial output.
    assert "a task" not in result.output


@pytest.mark.asyncio
async def test_single_doc_missing_errors(tmp_path):
    ds, internal = await file_backed_ds(tmp_path)

    result = _run_tasks(internal, "999")
    assert result.exit_code == 1, result.output
    assert "No paper doc with id 999" in result.output
