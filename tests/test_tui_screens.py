"""Screen tests for the TUI reader (datasette_paper.tui screens + widgets).

Driven in-process against the `ds` fixture via httpx.ASGITransport, same wiring
as tests/test_tui_client.py. Pilot tests use generous timeouts and prefer
driving screen methods directly over simulated keypresses where that is more
robust (Textual pilots can be finicky about the event loop).
"""

from __future__ import annotations

import asyncio
import sqlite3

import httpx
import pytest
from datasette.app import Datasette

pytest.importorskip("textual")

from textual.widgets import DataTable, Markdown, TextArea  # noqa: E402

from conftest import create_doc  # noqa: E402

from datasette_paper.instance import MAX_STEP_BYTES, get_registry  # noqa: E402
from datasette_paper.markdown_parser import markdown_to_fragment  # noqa: E402
from datasette_paper.tui.app import PaperApp  # noqa: E402
from datasette_paper.tui.client import PaperClient, SSEEvent  # noqa: E402
from datasette_paper.tui.prettify import prettify_markdown  # noqa: E402
from datasette_paper.tui.screens.browse import (  # noqa: E402
    BrowseRowsScreen,
    BrowseScreen,
)
from datasette_paper.tui.screens.doc_list import DocListScreen  # noqa: E402
from datasette_paper.tui.screens.doc_view import DocScreen  # noqa: E402
from datasette_paper.tui.screens.edit_modal import (  # noqa: E402
    ConfirmModal,
    EditModal,
)
from datasette_paper.tui.widgets.blocks import Callout  # noqa: E402
from datasette_paper.util import paper_db  # noqa: E402


CONTENT_DB = "content"


def _build_content_db(path, n_rows: int = 5) -> None:
    conn = sqlite3.connect(path)
    conn.execute("create table widgets (id integer primary key, name text)")
    for i in range(n_rows):
        conn.execute("insert into widgets (name) values (?)", (f"widget{i}",))
    conn.commit()
    conn.close()


async def _build_content_ds(tmp_path, n_rows: int = 5) -> Datasette:
    """A Datasette with paper's usual routes *and* a real ``content`` db
    attached — the shared ``ds`` fixture is internal-db-only, so the live
    sql_block/block_embed/BrowseScreen tests below build their own."""
    db_path = tmp_path / f"{CONTENT_DB}.db"
    _build_content_db(db_path, n_rows)
    ds = Datasette(
        files=[str(db_path)],
        memory=True,
        config={"permissions": {"datasette-paper-create": True}},
        settings={"max_post_body_bytes": MAX_STEP_BYTES + 1024 * 1024},
    )
    await ds.invoke_startup()
    return ds


class _CountingTransport(httpx.ASGITransport):
    """An ASGITransport that counts requests whose path matches ``prefix`` —
    used to prove a cached sql_block run makes no second HTTP call."""

    def __init__(self, *args, prefix: str, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.prefix = prefix
        self.calls: list = []

    async def handle_async_request(self, request):
        if request.url.path.startswith(self.prefix):
            self.calls.append(str(request.url))
        return await super().handle_async_request(request)


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


@pytest.mark.asyncio
# @feat tui: test — EditModal seeds RAW block markdown and saves a round-trip
async def test_edit_modal_seeds_raw_markdown_and_saves(ds):
    target = await _seed_doc(ds, "target body\n", name="Target Doc")
    doc_id = await _seed_doc(ds, f"See [[{target}]] now.\n", name="Referrer")
    async with _client_for(ds) as client:
        app = PaperApp(client, doc_id=doc_id)
        async with app.run_test() as pilot:
            await _wait_until(
                lambda: isinstance(app.screen, DocScreen) and app.screen.blocks, pilot
            )
            screen = app.screen
            screen._cursor = 0
            screen.action_edit_block()
            await _wait_until(lambda: isinstance(app.screen, EditModal), pilot)
            modal = app.screen
            editor = modal.query_one("#editor", TextArea)
            # Seeded with the canonical wikilink form, never the resolved title.
            assert f"[[{target}]]" in editor.text
            assert "Target Doc" not in editor.text

            editor.load_text(f"See [[{target}]] later.\n")
            modal.action_save()
            await _wait_until(lambda: isinstance(app.screen, DocScreen), pilot)

        md = await client.get_document_markdown(doc_id)
    assert "later" in md
    assert f"[[{target}]]" in md


@pytest.mark.asyncio
# @feat tui: test — a dirty EditModal Escape asks to confirm the discard
async def test_edit_modal_dirty_escape_confirms(ds):
    doc_id = await _seed_doc(ds, "hello world\n")
    async with _client_for(ds) as client:
        app = PaperApp(client, doc_id=doc_id)
        async with app.run_test() as pilot:
            await _wait_until(
                lambda: isinstance(app.screen, DocScreen) and app.screen.blocks, pilot
            )
            screen = app.screen
            screen._cursor = 0
            screen.action_edit_block()
            await _wait_until(lambda: isinstance(app.screen, EditModal), pilot)
            modal = app.screen
            modal.query_one("#editor", TextArea).load_text("dirty change\n")
            modal._dirty = True

            modal.action_cancel()
            # A dirty Escape opens the discard confirmation rather than closing.
            await _wait_until(lambda: isinstance(app.screen, ConfirmModal), pilot)
            assert isinstance(app.screen, ConfirmModal)

            # Declining keeps the editor open (nothing discarded).
            app.screen.action_cancel()
            await _wait_until(lambda: isinstance(app.screen, EditModal), pilot)
            assert isinstance(app.screen, EditModal)


async def _seed_content_doc(ds: Datasette, content: str, name: str = "Fixture") -> int:
    """Like ``_seed_doc``, but for a locally-built ``ds`` (``_build_content_ds``)
    that isn't wired through the shared fixture's default-actor monkeypatch —
    sign alice's cookie explicitly so she owns the doc (and can reopen it)."""
    cookie = ds.sign({"a": {"id": "alice"}}, "actor")
    resp = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": name, "content": content},
        cookies={"ds_actor": cookie},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
# @feat tui: test — sql_block Enter/ctrl+r runs the query; a second run hits the cache
async def test_sql_block_run_and_cache(tmp_path):
    ds = await _build_content_ds(tmp_path, n_rows=5)
    doc_id = await _seed_content_doc(
        ds, f"```sql db={CONTENT_DB}\nselect * from widgets order by id\n```\n"
    )

    transport = _CountingTransport(app=ds.app(), prefix=f"/{CONTENT_DB}/")
    cookie = ds.sign({"a": {"id": "alice"}}, "actor")
    client = PaperClient(
        base_url="http://testserver", transport=transport, cookies={"ds_actor": cookie}
    )
    async with client:
        app = PaperApp(client, doc_id=doc_id)
        async with app.run_test() as pilot:
            await _wait_until(
                lambda: isinstance(app.screen, DocScreen) and app.screen.blocks, pilot
            )
            screen = app.screen
            idx = [b.node_type for b in screen.blocks].index("sql_block")
            screen._cursor = idx

            await screen._run_current_block()
            await pilot.pause()
            table = screen.blocks[idx].query_one(DataTable)
            assert table.row_count == 5
            assert list(table.get_row_at(0)) == ["1", "widget0"]
            assert len(transport.calls) == 1

            # A second run of the identical (db, sql) pair hits the cache —
            # no additional HTTP call.
            await screen._run_current_block()
            await pilot.pause()
            assert len(transport.calls) == 1


@pytest.mark.asyncio
# @feat tui: test — block_embed's stored filter/sort config maps to Datasette query params
async def test_block_embed_filters_map_to_query_params(tmp_path):
    ds = await _build_content_ds(tmp_path, n_rows=5)
    fence = (
        "```paper-embed\n"
        '{"config": {"filters": [{"column": "name", "op": "contains", "value": "widget1"}], '
        '"sort": {"column": "id", "desc": true}}, "mode": "table", "ref": "/'
        + CONTENT_DB
        + '/widgets"}\n'
        "```\n"
    )
    doc_id = await _seed_content_doc(ds, fence)

    transport = _CountingTransport(app=ds.app(), prefix=f"/{CONTENT_DB}/widgets")
    cookie = ds.sign({"a": {"id": "alice"}}, "actor")
    client = PaperClient(
        base_url="http://testserver", transport=transport, cookies={"ds_actor": cookie}
    )
    async with client:
        app = PaperApp(client, doc_id=doc_id)
        async with app.run_test() as pilot:
            await _wait_until(
                lambda: isinstance(app.screen, DocScreen) and app.screen.blocks, pilot
            )
            await _wait_until(lambda: len(transport.calls) > 0, pilot)

    assert len(transport.calls) == 1
    assert "name__contains=widget1" in transport.calls[0]
    assert "_sort_desc=id" in transport.calls[0]


@pytest.mark.asyncio
# @feat tui: test — BrowseScreen lists the content db; BrowseRowsScreen paginates via _next
async def test_browse_screen_lists_db_and_rows_screen_paginates(tmp_path):
    ds = await _build_content_ds(tmp_path, n_rows=60)
    async with _client_for(ds) as client:
        app = PaperApp(client)
        async with app.run_test() as pilot:
            await _wait_until(lambda: isinstance(app.screen, DocListScreen), pilot)
            app.screen.action_browse()
            await _wait_until(lambda: isinstance(app.screen, BrowseScreen), pilot)
            await _wait_until(lambda: app.screen._names, pilot)
            assert CONTENT_DB in app.screen._names

            rows_screen = BrowseRowsScreen(client, CONTENT_DB, "widgets")
            await app.push_screen(rows_screen)
            await _wait_until(lambda: rows_screen._loaded_count > 0, pilot)
            assert rows_screen._loaded_count == 50
            assert rows_screen._exhausted is False
            assert rows_screen._next_token is not None

            await rows_screen.action_load_more()
            await pilot.pause()
            assert rows_screen._loaded_count == 60
            assert rows_screen._exhausted is True
