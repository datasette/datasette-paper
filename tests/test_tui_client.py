"""Protocol tests for the TUI client (datasette_paper.tui.client).

Driven in-process against the `ds` fixture via httpx.ASGITransport. The
fixtures bind a signed `alice` actor cookie; the PaperClient here gets the
same cookie through its `cookies=` injection path so per-doc permission
gates pass without a real token. No textual anywhere in this module.
"""

from __future__ import annotations

import asyncio
import sys

import httpx
import pytest
from click.testing import CliRunner
from datasette.cli import cli

from conftest import create_doc

from datasette_paper.instance import get_registry
from datasette_paper.markdown import doc_to_markdown
from datasette_paper.markdown_parser import markdown_to_fragment
from datasette_paper.tui.client import ConflictError, PaperClient
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
