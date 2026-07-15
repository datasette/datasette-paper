"""Protocol tests for the TUI client (datasette_paper.tui.client).

Driven in-process against the `ds` fixture via httpx.ASGITransport. The
fixtures bind a signed `alice` actor cookie; the PaperClient here gets the
same cookie through its `cookies=` injection path so per-doc permission
gates pass without a real token. No textual anywhere in this module.
"""

from __future__ import annotations

import asyncio
import copy
import sys

import httpx
import pytest
from click.testing import CliRunner
from datasette.cli import cli

from conftest import create_doc

from datasette_paper.instance import get_registry
from datasette_paper.markdown import doc_to_markdown
from datasette_paper.markdown_parser import markdown_to_fragment
from datasette_paper.tui.client import (
    ConflictError,
    PaperClient,
    ReadOnlyError,
)
from datasette_paper.util import paper_db


# A fixture doc covering the block families the reader must round-trip:
# heading, task list, table, callout, sql fence, source fence.
FIXTURE_MD = """# Heading

- [ ] task one
- [x] task two

| h1 | h2 |
| --- | --- |
| a | b |

> [!NOTE] Title
> body text

```sql db=data
select 1 as n
```

```source name=q db=data
select 2 as m
```
"""


def _client_for(ds, actor_id: str = "alice") -> PaperClient:
    """A PaperClient wired to the in-process ASGI app as `actor_id`."""
    transport = httpx.ASGITransport(app=ds.app())
    cookie = ds.sign({"a": {"id": actor_id}}, "actor")
    return PaperClient(
        base_url="http://testserver",
        transport=transport,
        cookies={"ds_actor": cookie},
    )


async def _seed_doc(ds, content: str) -> int:
    """Create a doc seeded from markdown (version-0 snapshot, no leading blank
    paragraph the way an empty create would leave)."""
    resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Fixture", "content": content}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_bootstrap_materialize_matches_document_markdown(ds):
    doc_id = await _seed_doc(ds, FIXTURE_MD)
    async with _client_for(ds) as client:
        session = await client.open_doc(doc_id)
        server_md = await client.get_document_markdown(doc_id)
    # The client materializes the same snapshot the server does; with no inline
    # refs/embeds in the fixture the resolver-less client serialize matches the
    # server's /document markdown byte for byte.
    assert doc_to_markdown(session.doc.to_json()) == server_md


@pytest.mark.asyncio
async def test_block_markdown_roundtrips_per_block(ds):
    doc_id = await _seed_doc(ds, FIXTURE_MD)
    async with _client_for(ds) as client:
        session = await client.open_doc(doc_id)

    kinds = [session.doc.child(i).type.name for i in range(session.block_count())]
    # Sanity: the fixture really does exercise each block family.
    assert kinds == ["heading", "task_list", "table", "callout", "sql_block", "source"]

    for i in range(session.block_count()):
        md = session.block_markdown(i)
        assert markdown_to_fragment(md) == [session.doc.child(i).to_json()], (
            f"block {i} ({kinds[i]}) did not round-trip: {md!r}"
        )


@pytest.mark.asyncio
# @feat tui: test: live SSE update reaches the client and apply_update lands it
async def test_sse_update_delivers_and_applies(ds):
    doc_id = await create_doc(ds)
    async with _client_for(ds) as client:
        session = await client.open_doc(doc_id)
        before = session.block_count()
        gen = session.events()

        async def next_update():
            async for ev in gen:
                if ev.kind == "update":
                    return ev
            raise AssertionError("SSE stream ended without an update")

        task = asyncio.create_task(next_update())
        # Let the SSE stream subscribe before we trigger the broadcast.
        await asyncio.sleep(0.3)
        instance = await get_registry(ds).get(paper_db(ds), doc_id)
        await instance.append_fragment(
            markdown_to_fragment("appended line\n"), actor_id="alice"
        )
        try:
            event = await asyncio.wait_for(task, timeout=5.0)
        finally:
            await gen.aclose()

    assert event.kind == "update"
    touched = session.apply_update(event.data)
    assert session.block_count() == before + 1
    assert touched  # some top-level block index was reported as changed
    assert "appended line" in doc_to_markdown(session.doc.to_json())
    assert session.version == event.data["version"]


@pytest.mark.asyncio
async def test_submit_replace_happy_and_stale(ds):
    doc_id = await _seed_doc(ds, "hello world\n")
    async with _client_for(ds) as client:
        s1 = await client.open_doc(doc_id)
        s2 = await client.open_doc(doc_id)  # second session at the same version
        assert s1.version == 0

        end = s1.doc.child(0).node_size
        new_version = await s1.submit_replace(
            0, end, markdown_to_fragment("replaced one\n")
        )
        assert new_version == 1
        assert s1.version == 1
        # Server-side version advanced (a fresh bootstrap sees it).
        fresh = await client.open_doc(doc_id)
        assert fresh.version == 1
        assert "replaced one" in doc_to_markdown(fresh.doc.to_json())

        # s2 is still at version 0 → stale submit is a typed conflict.
        with pytest.raises(ConflictError):
            await s2.submit_replace(
                0, s2.doc.child(0).node_size, markdown_to_fragment("replaced two\n")
            )


async def _catch_up_from(instance, session):
    """Return a ``catch_up`` hook that feeds ``session`` the steps it's missing
    from ``instance`` (the server-side Instance) and applies them under the
    session lock — stands in for the live SSE worker in a headless test."""

    async def catch_up():
        batch = instance.get_events(session.version)
        if batch is not None:
            async with session.lock:
                session.apply_update(batch)

    return catch_up


@pytest.mark.asyncio
# @feat tui: test — save_block edits a block, server reflects it, actor attributed
async def test_save_block_happy_and_attribution(ds):
    doc_id = await _seed_doc(ds, "alpha block\n\nbeta block\n")
    async with _client_for(ds) as client:
        session = await client.open_doc(doc_id)
        assert session.block_count() == 2
        old_json = session.doc.child(1).to_json()
        result = await session.save_block(1, old_json, "beta edited\n")
        assert result.kind == "saved"
        assert result.version == 1
        assert session.version == 1
        server_md = await client.get_document_markdown(doc_id)

    assert "beta edited" in server_md
    assert "alpha block" in server_md
    assert "beta block" not in server_md

    # The accepted step attributes the acting actor in the durable rollup.
    rows = await paper_db(ds).database.execute(
        "SELECT actor_id FROM _datasette_paper_doc_activity WHERE doc_id = ?",
        [doc_id],
    )
    assert [r["actor_id"] for r in rows] == ["alice"]


@pytest.mark.asyncio
# @feat tui: test — empty text needs delete-confirm; deletion + blank-line split
async def test_save_block_delete_and_split(ds):
    doc_id = await _seed_doc(ds, "one\n\ntwo\n\nthree\n")
    async with _client_for(ds) as client:
        session = await client.open_doc(doc_id)
        assert session.block_count() == 3

        # Whitespace-only text is an implicit deletion: flagged, not written.
        old1 = session.doc.child(1).to_json()
        pending = await session.save_block(1, old1, "   ")
        assert pending.kind == "needs_delete_confirm"
        assert session.version == 0

        # Confirmed deletion removes exactly the target block.
        deleted = await session.save_block(1, old1, "", confirmed_delete=True)
        assert deleted.kind == "saved"
        assert session.block_count() == 2
        md = await client.get_document_markdown(doc_id)
        assert "two" not in md
        assert "one" in md and "three" in md

        # A blank line typed into one block splits it into two nodes.
        old0 = session.doc.child(0).to_json()
        split = await session.save_block(0, old0, "first\n\nsecond\n")
        assert split.kind == "saved"
        assert session.block_count() == 3


@pytest.mark.asyncio
# @feat tui: test — save_block_json flips a task item's checked in the live doc
async def test_save_block_json_task_toggle(ds):
    doc_id = await _seed_doc(ds, "- [ ] wash\n- [ ] cook\n")
    async with _client_for(ds) as client:
        session = await client.open_doc(doc_id)
        node = session.doc.child(0).to_json()
        assert node["type"] == "task_list"
        new = copy.deepcopy(node)
        new["content"][0].setdefault("attrs", {})["checked"] = True
        result = await session.save_block_json(0, node, [new])
        assert result.kind == "saved"
        md = await client.get_document_markdown(doc_id)

    assert "[x] wash" in md
    assert "[ ] cook" in md


@pytest.mark.asyncio
# @feat tui: test — a remote edit to a DIFFERENT block: 409 → catch-up → relocate
async def test_save_block_relocate_after_conflict(ds):
    doc_id = await _seed_doc(ds, "aaa\n\nbbb\n\nccc\n")
    async with _client_for(ds) as client:
        session = await client.open_doc(doc_id)
        assert session.block_count() == 3
        old_ccc = session.doc.child(2).to_json()

        instance = await get_registry(ds).get(paper_db(ds), doc_id)
        # Remote deletes the FIRST block → ccc shifts from index 2 to index 1.
        await instance.apply_markdown_edit(
            lambda md: md.replace("aaa\n\n", "", 1), actor_id="bob"
        )

        result = await session.save_block(
            2, old_ccc, "ccc edited\n", catch_up=await _catch_up_from(instance, session)
        )
        assert result.kind == "saved"
        server_md = await client.get_document_markdown(doc_id)

    assert "aaa" not in server_md
    assert "bbb" in server_md
    assert server_md.count("ccc edited") == 1


@pytest.mark.asyncio
# @feat tui: test — a remote edit to the SAME block: changed_remotely, no write
async def test_save_block_same_block_conflict(ds):
    doc_id = await _seed_doc(ds, "keep me\n\ntarget block\n")
    async with _client_for(ds) as client:
        session = await client.open_doc(doc_id)
        old_json = session.doc.child(1).to_json()

        instance = await get_registry(ds).get(paper_db(ds), doc_id)
        await instance.apply_markdown_edit(
            lambda md: md.replace("target block", "remote wins"), actor_id="bob"
        )

        result = await session.save_block(
            1, old_json, "mine wins\n", catch_up=await _catch_up_from(instance, session)
        )
        assert result.kind == "changed_remotely"
        assert "remote wins" in (result.their_markdown or "")
        server_md = await client.get_document_markdown(doc_id)

    assert "remote wins" in server_md
    assert "mine wins" not in server_md


@pytest.mark.asyncio
# @feat tui: test — a locked doc refuses the save client-side (ReadOnlyError)
async def test_save_block_locked_refused(ds):
    doc_id = await _seed_doc(ds, "hello world\n")
    await paper_db(ds).set_doc_locked(doc_id=doc_id, locked=True)
    async with _client_for(ds) as client:
        session = await client.open_doc(doc_id)
        assert session.can_edit is False
        old_json = session.doc.child(0).to_json()
        with pytest.raises(ReadOnlyError):
            await session.save_block(0, old_json, "changed text\n")
        md = await client.get_document_markdown(doc_id)

    assert "changed text" not in md
    assert "hello world" in md


def test_cli_tui_help():
    result = CliRunner().invoke(cli, ["paper", "tui", "--help"])
    assert result.exit_code == 0
    assert "URL" in result.output
    assert "--token" in result.output
    assert "--doc" in result.output


def test_cli_tui_missing_textual(monkeypatch):
    # Simulate the [tui] extra not being installed: importing the textual-backed
    # app module raises ImportError.
    monkeypatch.setitem(sys.modules, "datasette_paper.tui.app", None)
    result = CliRunner().invoke(cli, ["paper", "tui"])
    assert result.exit_code == 1
    assert "pip install 'datasette-paper[tui]'" in result.output
