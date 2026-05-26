"""Tests for the datasette-agent tool integration (agent_tools.py).

The tools are called directly here (``tool.fn(datasette=, actor=, **params)``)
the same way the agent harness invokes them. Per-doc permission is checked
inside each tool; create_paper is gated by a resource-less required_permission.
"""

import json

import pytest

from datasette_agent.tools import (
    filter_tools_for_actor,
    get_agent_tools,
)

from datasette_paper.agent_tools import get_paper_agent_tools

from conftest import make_datasette

ALICE = {"id": "alice"}
BOB = {"id": "bob"}


def _tools():
    return {t.name: t for t in get_paper_agent_tools()}


async def _ds():
    ds = make_datasette(granted=True)
    await ds.invoke_startup()
    return ds


async def _call(tool_name, ds, actor, **params):
    result = await _tools()[tool_name].fn(datasette=ds, actor=actor, **params)
    return json.loads(result)


# ---------------------------------------------------------------------------
# create_paper
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_paper_blank():
    ds = await _ds()
    out = await _call("create_paper", ds, ALICE, name="My Doc")
    assert out["name"] == "My Doc"
    assert isinstance(out["doc_id"], int)
    assert out["url"].endswith(f"/-/paper/doc/{out['doc_id']}")


@pytest.mark.asyncio
async def test_create_paper_with_content():
    ds = await _ds()
    out = await _call(
        "create_paper", ds, ALICE, name="Seeded", content="# Title\n\nBody.\n"
    )
    read = await _call("read_paper", ds, ALICE, doc_id=out["doc_id"])
    assert "# Title" in read["content_markdown"]
    assert "Body." in read["content_markdown"]


# ---------------------------------------------------------------------------
# read_paper
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_paper_returns_markdown():
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="R", content="hello\n")
    out = await _call("read_paper", ds, ALICE, doc_id=created["doc_id"])
    assert out["content_markdown"] == "hello\n"
    assert out["version"] >= 0


@pytest.mark.asyncio
async def test_read_paper_not_found():
    ds = await _ds()
    out = await _call("read_paper", ds, ALICE, doc_id=99999)
    # Owner-less / nonexistent doc → permission gate denies before existence.
    assert "error" in out


@pytest.mark.asyncio
async def test_read_paper_permission_denied_for_other_actor():
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="Private", content="secret\n")
    out = await _call("read_paper", ds, BOB, doc_id=created["doc_id"])
    assert out["error"] == "Permission denied"


# ---------------------------------------------------------------------------
# append_to_paper
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_append_to_paper():
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="A", content="start\n")
    out = await _call(
        "append_to_paper", ds, ALICE, doc_id=created["doc_id"], content="# Added\n"
    )
    assert out["appended_blocks"] == 1
    read = await _call("read_paper", ds, ALICE, doc_id=created["doc_id"])
    assert "start" in read["content_markdown"]
    assert "# Added" in read["content_markdown"]


@pytest.mark.asyncio
async def test_append_denied_for_other_actor():
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="A", content="x\n")
    out = await _call(
        "append_to_paper", ds, BOB, doc_id=created["doc_id"], content="y\n"
    )
    assert out["error"] == "Permission denied"


# ---------------------------------------------------------------------------
# edit_paper (str_replace)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_edit_paper_replaces_unique_text():
    ds = await _ds()
    created = await _call(
        "create_paper", ds, ALICE, name="E", content="The quick brown fox.\n"
    )
    out = await _call(
        "edit_paper",
        ds,
        ALICE,
        doc_id=created["doc_id"],
        old_str="quick brown",
        new_str="slow green",
    )
    assert "slow green" in out["content_markdown"]
    assert "quick brown" not in out["content_markdown"]


@pytest.mark.asyncio
async def test_edit_paper_no_match_errors():
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="E", content="hello\n")
    out = await _call(
        "edit_paper", ds, ALICE, doc_id=created["doc_id"], old_str="nope", new_str="x"
    )
    assert out["error"] == "edit_failed"
    assert "not found" in out["message"]


@pytest.mark.asyncio
async def test_edit_paper_ambiguous_match_errors():
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="E", content="ab ab ab\n")
    out = await _call(
        "edit_paper", ds, ALICE, doc_id=created["doc_id"], old_str="ab", new_str="x"
    )
    assert out["error"] == "edit_failed"
    assert "matches" in out["message"]


@pytest.mark.asyncio
async def test_edit_paper_empty_old_str_errors():
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="E", content="hi\n")
    out = await _call(
        "edit_paper", ds, ALICE, doc_id=created["doc_id"], old_str="", new_str="x"
    )
    assert "error" in out


@pytest.mark.asyncio
async def test_edit_paper_marks_survive_unrelated_edit():
    """A targeted edit must not strip marks elsewhere (serializer round-trip)."""
    ds = await _ds()
    created = await _call(
        "create_paper",
        ds,
        ALICE,
        name="E",
        content="Keep this **bold** word.\n\nEdit this line.\n",
    )
    out = await _call(
        "edit_paper",
        ds,
        ALICE,
        doc_id=created["doc_id"],
        old_str="Edit this line.",
        new_str="Edited!",
    )
    assert "**bold**" in out["content_markdown"]  # untouched mark preserved
    assert "Edited!" in out["content_markdown"]


# ---------------------------------------------------------------------------
# insert_into_paper
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_insert_into_paper_after_anchor():
    ds = await _ds()
    created = await _call(
        "create_paper", ds, ALICE, name="I", content="# Intro\n\nEnd.\n"
    )
    out = await _call(
        "insert_into_paper",
        ds,
        ALICE,
        doc_id=created["doc_id"],
        anchor="# Intro",
        content="Inserted paragraph.",
    )
    md = out["content_markdown"]
    # Inserted block lands between the intro heading and the end paragraph.
    assert md.index("Intro") < md.index("Inserted paragraph.") < md.index("End.")


@pytest.mark.asyncio
async def test_insert_anchor_not_found_errors():
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="I", content="x\n")
    out = await _call(
        "insert_into_paper",
        ds,
        ALICE,
        doc_id=created["doc_id"],
        anchor="missing",
        content="y",
    )
    assert out["error"] == "edit_failed"


# ---------------------------------------------------------------------------
# hook registration + permission gating
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tools_registered_via_hook():
    ds = await _ds()
    names = {t.name for t in await get_agent_tools(ds)}
    assert {
        "create_paper",
        "read_paper",
        "append_to_paper",
        "edit_paper",
        "insert_into_paper",
    } <= names


@pytest.mark.asyncio
async def test_create_paper_filtered_out_without_create_permission():
    # granted=False → datasette-paper-create unset → create_paper is filtered
    # from the list a non-root actor sees; the others (no required_permission)
    # remain.
    ds = make_datasette(granted=False)
    await ds.invoke_startup()
    tools = get_paper_agent_tools()
    visible = {t.name for t in await filter_tools_for_actor(ds, BOB, tools)}
    assert "create_paper" not in visible
    assert "read_paper" in visible
    assert "edit_paper" in visible
