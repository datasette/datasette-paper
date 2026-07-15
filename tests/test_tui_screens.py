"""Screen tests for the TUI reader (datasette_paper.tui screens + widgets).

Driven in-process against the `ds` fixture via httpx.ASGITransport, same wiring
as tests/test_tui_client.py. Pilot tests use generous timeouts and prefer
driving screen methods directly over simulated keypresses where that is more
robust (Textual pilots can be finicky about the event loop).
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

pytest.importorskip("textual")

from textual.widgets import Markdown  # noqa: E402

from conftest import create_doc  # noqa: E402

from datasette_paper.instance import get_registry  # noqa: E402
from datasette_paper.markdown_parser import markdown_to_fragment  # noqa: E402
from datasette_paper.tui.app import PaperApp  # noqa: E402
from datasette_paper.tui.client import PaperClient, SSEEvent  # noqa: E402
from datasette_paper.tui.prettify import prettify_markdown  # noqa: E402
from datasette_paper.tui.screens.doc_list import DocListScreen  # noqa: E402
from datasette_paper.tui.screens.doc_view import DocScreen  # noqa: E402
from datasette_paper.tui.widgets.blocks import Callout  # noqa: E402
from datasette_paper.util import paper_db  # noqa: E402


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
"""


def _client_for(ds, actor_id: str = "alice") -> PaperClient:
    transport = httpx.ASGITransport(app=ds.app())
    cookie = ds.sign({"a": {"id": actor_id}}, "actor")
    return PaperClient(
        base_url="http://testserver",
        transport=transport,
        cookies={"ds_actor": cookie},
    )


async def _seed_doc(ds, content: str, name: str = "Fixture") -> int:
    resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": name, "content": content}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _wait_until(predicate, pilot, timeout: float = 5.0):
    """Pump the pilot until ``predicate()`` is true or ``timeout`` elapses."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return True
        await pilot.pause(0.05)
    return predicate()


@pytest.mark.asyncio
async def test_doc_list_renders_and_opens(ds):
    await _seed_doc(ds, "hello one\n", name="One")
    await _seed_doc(ds, "hello two\n", name="Two")
    async with _client_for(ds) as client:
        app = PaperApp(client)
        async with app.run_test() as pilot:
            await _wait_until(
                lambda: (
                    isinstance(app.screen, DocListScreen)
                    and app.screen.table.row_count >= 2
                ),
                pilot,
            )
            screen = app.screen
            assert isinstance(screen, DocListScreen)
            names = {r.get("name") for r in screen._all_rows}
            assert {"One", "Two"} <= names

            # App navigation API pushes a DocScreen (the Enter path).
            doc_id = screen._all_rows[0]["id"]
            await screen.open_doc_id(doc_id)
            await _wait_until(lambda: isinstance(app.screen, DocScreen), pilot)
            assert isinstance(app.screen, DocScreen)


@pytest.mark.asyncio
# @feat tui: test: DocScreen renders one widget per top-level block + callout toggle
async def test_doc_screen_blocks_and_callout_toggle(ds):
    doc_id = await _seed_doc(ds, FIXTURE_MD)
    async with _client_for(ds) as client:
        app = PaperApp(client, doc_id=doc_id)
        async with app.run_test() as pilot:
            await _wait_until(
                lambda: isinstance(app.screen, DocScreen) and app.screen.blocks,
                pilot,
            )
            screen = app.screen
            # One widget per top-level block (heading, tasks, table, callout, sql).
            assert len(screen.blocks) == screen.session.block_count() == 5
            types = [b.node_type for b in screen.blocks]
            assert types == ["heading", "task_list", "table", "callout", "sql_block"]

            callout_idx = types.index("callout")
            callout = screen.blocks[callout_idx].query_one(Callout)
            assert callout.collapsed is False
            assert callout._body.display is True

            # Space on the focused callout hides its body locally (no network).
            screen._cursor = callout_idx
            screen.action_toggle_callout()
            await pilot.pause()
            assert callout.collapsed is True
            assert callout._body.display is False


@pytest.mark.asyncio
# @feat tui: test: a live update batch mounts a new block widget on the open screen
async def test_doc_screen_live_update_adds_block(ds):
    doc_id = await create_doc(ds)
    async with _client_for(ds) as client:
        app = PaperApp(client, doc_id=doc_id)
        async with app.run_test() as pilot:
            await _wait_until(
                lambda: isinstance(app.screen, DocScreen) and app.screen.blocks,
                pilot,
            )
            screen = app.screen
            before = len(screen.blocks)
            before_version = screen.session.version

            # Real server-side append advances the doc + version. httpx's
            # ASGITransport can't pump a long-lived SSE stream inside Textual's
            # run_test loop (the stream only flushes at teardown — the real SSE
            # reader is covered by tests/test_tui_client.py), so we deliver the
            # exact broadcast batch the server produced through the screen's own
            # event handler — the identical code path the SSE worker drives.
            instance = await get_registry(ds).get(paper_db(ds), doc_id)
            await instance.append_fragment(
                markdown_to_fragment("appended paragraph\n"), actor_id="alice"
            )
            batch = instance.get_events(before_version)
            assert batch is not None and batch["kind"] == "update"

            await screen._handle_event(SSEEvent("update", batch))
            await pilot.pause()

            assert len(screen.blocks) == before + 1
            assert screen.session.block_count() == before + 1
            assert screen.session.version == batch["version"]


def test_prettify_resolves_wikilink_and_preserves_canonical():
    md = "See [[7]] for details.\n"
    links_map = {"7": {"status": "ok", "title": "Design Notes"}}
    out = prettify_markdown(md, links_map, {})
    assert "Design Notes" in out
    assert "[[7]]" not in out
    # Denied / unresolved ids keep the canonical form.
    assert "[[7]]" in prettify_markdown(md, {"7": {"status": "denied"}}, {})


@pytest.mark.asyncio
async def test_doc_screen_wikilink_shows_title(ds):
    target = await _seed_doc(ds, "target body\n", name="Target Doc")
    doc_id = await _seed_doc(ds, f"See [[{target}]] now.\n", name="Referrer")
    async with _client_for(ds) as client:
        app = PaperApp(client, doc_id=doc_id)
        async with app.run_test() as pilot:
            await _wait_until(
                lambda: isinstance(app.screen, DocScreen) and app.screen.blocks,
                pilot,
            )
            screen = app.screen
            # Canonical block markdown is untouched (editing starts from it).
            assert f"[[{target}]]" in screen.session.block_markdown(0)
            # The displayed Markdown widget shows the resolved title.
            md_widget = screen.blocks[0].query_one(Markdown)
            assert "Target Doc" in md_widget.source
            assert f"[[{target}]]" not in md_widget.source
