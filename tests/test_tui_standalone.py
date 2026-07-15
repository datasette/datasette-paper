"""Standalone (internal.db) mode for the TUI — datasette_paper.tui.standalone.

These exercise the bootstrap helper and CLI target sniffing without textual: an
in-process Datasette is booted on a tmp internal.db over ASGITransport, and the
same PaperClient protocol used by every other TUI test drives it. The single
cross-cutting rule this mode must honor is one-writer-per-file; the guard test
proves the probe refuses a locked file.
"""

from __future__ import annotations

import asyncio
import gc
import sqlite3

import pytest
from click.testing import CliRunner
from datasette.cli import cli

from datasette_paper.tui import datasette_api
from datasette_paper.tui.standalone import (
    default_actor_id,
    resolve_tui_target,
    standalone_client,
)


def _read_created_by(internal_path, doc_id: int):
    """Read ``created_by`` for *doc_id* straight from the internal.db file.

    A separate read-only connection (the in-process Datasette is idle between
    requests, so no write lock blocks the read)."""
    conn = sqlite3.connect(str(internal_path))
    try:
        row = conn.execute(
            "SELECT created_by FROM _datasette_paper_doc WHERE id = ?", [doc_id]
        ).fetchone()
    finally:
        conn.close()
    return row[0] if row else None


@pytest.mark.asyncio
async def test_boot_create_and_reopen_persists(tmp_path):
    internal = tmp_path / "internal.db"
    # Fresh (missing) file: the probe succeeds and migrations create + populate it.
    client = await standalone_client(internal, actor_id="local")
    try:
        created = await client.create("Persisted doc")
        doc_id = created["id"]
        await client.append(doc_id, "hello standalone\n")
        md = await client.get_document_markdown(doc_id)
        assert "hello standalone" in md
    finally:
        await client.close()
    # Drop the first Datasette so its idle connection can't be mistaken for a
    # live writer, then reopen the same file.
    del client
    gc.collect()

    client2 = await standalone_client(internal, actor_id="local")
    try:
        docs = await client2.list_docs()
        assert any(d["id"] == doc_id for d in docs)
        md2 = await client2.get_document_markdown(doc_id)
        assert "hello standalone" in md2
    finally:
        await client2.close()


@pytest.mark.asyncio
async def test_actor_attribution(tmp_path):
    internal = tmp_path / "internal.db"
    client = await standalone_client(internal, actor_id="tui-tester")
    try:
        created = await client.create("Attributed")
        doc_id = created["id"]
    finally:
        await client.close()
    assert _read_created_by(internal, doc_id) == "tui-tester"


@pytest.mark.asyncio
async def test_attach_content_db_runs_sql(tmp_path):
    # A small content database to attach via --db.
    data_path = tmp_path / "data.db"
    conn = sqlite3.connect(str(data_path))
    conn.execute("CREATE TABLE widgets (id integer primary key, label text)")
    conn.execute("INSERT INTO widgets (label) VALUES ('alpha'), ('beta')")
    conn.commit()
    conn.close()

    internal = tmp_path / "internal.db"
    client = await standalone_client(internal, content_dbs=[str(data_path)])
    try:
        # A sql_block fence targets db=data; run it through the same JSON-API
        # helper the sql widget uses (protocol level — no pilot needed).
        result = await datasette_api.run_sql(
            client, "data", "select count(*) as n from widgets"
        )
        assert result.ok, result.error
        assert result.rows[0]["n"] == 2
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_single_writer_guard(tmp_path):
    internal = tmp_path / "internal.db"
    # Boot once so the file exists and is migrated.
    client = await standalone_client(internal)
    await client.close()
    del client
    gc.collect()

    # Simulate a live server holding a write transaction on the file.
    holder = sqlite3.connect(str(internal))
    holder.execute("BEGIN IMMEDIATE")
    try:
        with pytest.raises(RuntimeError) as exc:
            await standalone_client(internal)
        assert "another process" in str(exc.value).lower()
    finally:
        holder.rollback()
        holder.close()


@pytest.mark.asyncio
async def test_missing_parent_dir_errors(tmp_path):
    missing = tmp_path / "nope" / "internal.db"
    with pytest.raises(RuntimeError) as exc:
        await standalone_client(missing)
    assert "does not exist" in str(exc.value)


@pytest.mark.asyncio
# @feat tui: test — SSE update from a same-client append reaches a standalone session
async def test_sse_update_in_process(tmp_path):
    internal = tmp_path / "internal.db"
    client = await standalone_client(internal, actor_id="local")
    try:
        created = await client.create("SSE doc")
        doc_id = created["id"]
        session = await client.open_doc(doc_id)
        before = session.block_count()
        gen = session.events()

        async def next_update():
            async for ev in gen:
                if ev.kind == "update":
                    return ev
            raise AssertionError("SSE stream ended without an update")

        task = asyncio.create_task(next_update())
        await asyncio.sleep(0.3)  # let the stream subscribe first
        await client.append(doc_id, "appended over sse\n")
        try:
            event = await asyncio.wait_for(task, timeout=5.0)
        finally:
            await gen.aclose()
    finally:
        await client.close()

    session.apply_update(event.data)
    assert session.block_count() == before + 1
    assert session.version == event.data["version"]


# --- CLI target sniffing (pure function) ---------------------------------


def test_sniff_url_is_url_mode():
    resolved = resolve_tui_target("http://localhost:8001")
    assert resolved["mode"] == "url"
    assert resolved["url"] == "http://localhost:8001"


def test_sniff_existing_file_is_internal(tmp_path):
    f = tmp_path / "papers.db"
    f.write_bytes(b"")
    resolved = resolve_tui_target(str(f))
    assert resolved["mode"] == "internal"
    assert resolved["internal_path"] == str(f)


def test_sniff_bare_path_is_internal():
    resolved = resolve_tui_target("some/papers.db")
    assert resolved["mode"] == "internal"


def test_internal_flag_forces_path():
    # An http-looking target is still read as a path when --internal is set.
    resolved = resolve_tui_target("http://not-a-url", internal=True)
    assert resolved["mode"] == "internal"
    assert resolved["internal_path"] == "http://not-a-url"


def test_sniff_ambiguous_target_is_usage_error():
    # A scheme-less target that is neither an existing file nor *.db (a typo'd
    # hostname, say) must not silently become a fresh SQLite file in the cwd.
    import click

    with pytest.raises(click.UsageError, match="Ambiguous target"):
        resolve_tui_target("localhost:8001")


def test_token_with_path_is_usage_error():
    import click

    with pytest.raises(click.UsageError):
        resolve_tui_target("papers.db", token="dstok_abc")


def test_db_with_url_is_usage_error():
    import click

    with pytest.raises(click.UsageError):
        resolve_tui_target("http://localhost:8001", dbs=["data.db"])


def test_default_actor_id_env(monkeypatch):
    monkeypatch.setenv("USER", "someone")
    assert default_actor_id() == "someone"
    monkeypatch.delenv("USER", raising=False)
    assert default_actor_id() == "local"


def test_cli_tui_help_documents_both_modes():
    result = CliRunner().invoke(cli, ["paper", "tui", "--help"])
    assert result.exit_code == 0
    assert "URL" in result.output
    assert "--internal" in result.output
    assert "--db" in result.output
