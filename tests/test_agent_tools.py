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
from datasette_paper.permissions import PAPER_DOC_RESOURCE_TYPE, PAPER_DOCS_PARENT

from conftest import make_datasette

ALICE = {"id": "alice"}
BOB = {"id": "bob"}


async def _grant_acl(ds, doc_id, actor_id, role):
    """Grant ``actor_id`` an acl role (Viewer/Editor/Manager) on the doc."""
    from datasette_acl.grants import grant, Principal

    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.actor(actor_id),
        role=role,
        by_actor="alice",
    )


async def _revoke_acl(ds, doc_id, actor_id):
    from datasette_acl.grants import revoke, Principal

    await revoke(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.actor(actor_id),
        by_actor="alice",
    )


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
# Permission rules: agent tools honour acl read / edit grants
#
# read_paper gates on paper-view; append/edit/insert gate on paper-edit. So a
# Viewer grant (paper-view only) may read but not write, an Editor grant
# (paper-view + paper-edit) may do both, and an actor with no grant may do
# neither — exactly the human permission model. The owner-only cases live in
# the per-tool sections above; these exercise the shared / read-only / revoked
# paths an agent acting as a non-owner would hit.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_allowed_only_with_grant():
    """An agent may read a doc the actor can view — not before, not after revoke."""
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="Shared", content="hi bob\n")
    doc_id = created["doc_id"]
    # No grant yet → denied.
    denied = await _call("read_paper", ds, BOB, doc_id=doc_id)
    assert denied["error"] == "Permission denied"
    # Viewer grant → can read.
    await _grant_acl(ds, doc_id, "bob", "Viewer")
    out = await _call("read_paper", ds, BOB, doc_id=doc_id)
    assert out["content_markdown"] == "hi bob\n"
    # Revoke → denied again.
    await _revoke_acl(ds, doc_id, "bob")
    again = await _call("read_paper", ds, BOB, doc_id=doc_id)
    assert again["error"] == "Permission denied"


@pytest.mark.asyncio
async def test_viewer_grant_can_read_but_not_write():
    """A read-only (Viewer) actor may read but every write tool is denied."""
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="RO", content="line one\n")
    doc_id = created["doc_id"]
    await _grant_acl(ds, doc_id, "bob", "Viewer")
    # Read works.
    assert "content_markdown" in await _call("read_paper", ds, BOB, doc_id=doc_id)
    # Every write tool is denied for the read-only actor.
    appended = await _call("append_to_paper", ds, BOB, doc_id=doc_id, content="x\n")
    assert appended["error"] == "Permission denied"
    edited = await _call(
        "edit_paper", ds, BOB, doc_id=doc_id, old_str="line one", new_str="x"
    )
    assert edited["error"] == "Permission denied"
    inserted = await _call(
        "insert_into_paper", ds, BOB, doc_id=doc_id, anchor="line one", content="x"
    )
    assert inserted["error"] == "Permission denied"
    # The denied writes never touched the doc.
    owner_view = await _call("read_paper", ds, ALICE, doc_id=doc_id)
    assert owner_view["content_markdown"] == "line one\n"


@pytest.mark.asyncio
async def test_editor_grant_can_read_and_write():
    """An Editor (paper-view + paper-edit) may use read and all write tools."""
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="RW", content="alpha\n")
    doc_id = created["doc_id"]
    await _grant_acl(ds, doc_id, "bob", "Editor")
    assert "content_markdown" in await _call("read_paper", ds, BOB, doc_id=doc_id)
    appended = await _call("append_to_paper", ds, BOB, doc_id=doc_id, content="beta\n")
    assert appended["appended_blocks"] == 1
    edited = await _call(
        "edit_paper", ds, BOB, doc_id=doc_id, old_str="alpha", new_str="ALPHA"
    )
    assert "ALPHA" in edited["content_markdown"]
    inserted = await _call(
        "insert_into_paper", ds, BOB, doc_id=doc_id, anchor="ALPHA", content="gamma"
    )
    assert "gamma" in inserted["content_markdown"]


@pytest.mark.asyncio
async def test_edit_paper_denied_for_other_actor():
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="E", content="text here\n")
    out = await _call(
        "edit_paper", ds, BOB, doc_id=created["doc_id"], old_str="text", new_str="x"
    )
    assert out["error"] == "Permission denied"


@pytest.mark.asyncio
async def test_insert_into_paper_denied_for_other_actor():
    ds = await _ds()
    created = await _call("create_paper", ds, ALICE, name="I", content="anchor here\n")
    out = await _call(
        "insert_into_paper",
        ds,
        BOB,
        doc_id=created["doc_id"],
        anchor="anchor",
        content="x",
    )
    assert out["error"] == "Permission denied"


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
