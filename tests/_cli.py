"""Shared helpers for `datasette paper` CLI tests.

Every CLI subcommand test file boots a real *file-backed* Datasette
(unlike the shared in-memory `ds` fixture in conftest.py), because the
CLI reads a doc from an internal database file with no server running.
Content goes in through the normal append pipeline so the seeded file
reflects real snapshot/step history, and history-corruption cases mutate
a *copy* of that file with a raw sqlite3 connection so the live Datasette
never fights the mutation for locks.

Public API:

- `file_backed_ds(tmp_path)` — a Datasette whose internal db is a real
  file under *tmp_path*; returns `(ds, internal_path)`.
- `create_doc_with_content(ds, content=...)` — create a doc and append
  markdown to it; returns the doc id.
- `append(ds, doc_id, content)` — append markdown to an existing doc.
- `document_markdown(ds, doc_id)` — the `/document` endpoint's rendered
  markdown, for comparing against CLI output.
- `snapshot_at_current_version(ds, doc_id)` — write a real snapshot of the
  doc's live state; returns its version.
- `mutated_copy(internal, tmp_path, name, *statements)` — copy the
  internal db file and run raw SQL statements against the copy.
- `run_cli(*args)` — invoke `datasette <args>` via `CliRunner`, e.g.
  `run_cli("paper", "export", db_path, str(doc_id))`.
"""

import json
import shutil
import sqlite3

from click.testing import CliRunner
from datasette.app import Datasette
from datasette.cli import cli

from conftest import DEFAULT_ACTOR_ID, _bind_default_actor
from datasette_paper.db import PaperDB
from datasette_paper.instance import get_registry


async def file_backed_ds(tmp_path):
    """A Datasette whose internal db is a real file under *tmp_path*."""
    internal = str(tmp_path / "internal.db")
    ds = Datasette(
        memory=True,
        internal=internal,
        config={"permissions": {"datasette-paper-create": True}},
    )
    await ds.invoke_startup()
    _bind_default_actor(ds, DEFAULT_ACTOR_ID)
    return ds, internal


#: Small representative markdown snippet — the default seed content for
#: `create_doc_with_content` when a test doesn't care about the specifics.
DEFAULT_CONTENT_MD = "# Title\n\nHello **world**.\n\n- [ ] a task\n"


async def create_doc_with_content(ds, content=DEFAULT_CONTENT_MD, name="Exportable"):
    resp = await ds.client.post("/-/paper/api/docs", json={"name": name})
    assert resp.status_code == 201, resp.text
    doc_id = resp.json()["id"]
    await append(ds, doc_id, content)
    return doc_id


async def append(ds, doc_id, content):
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": content}
    )
    assert resp.status_code == 200, resp.text


async def document_markdown(ds, doc_id):
    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/document")
    assert resp.status_code == 200
    return resp.json()["content_markdown"]


async def snapshot_at_current_version(ds, doc_id):
    """Write a real snapshot of the doc's live state; return its version."""
    db = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    inst = await registry.get(db, doc_id)
    live = inst.materialize_live_doc()
    version = inst.version
    await db.insert_snapshot(
        doc_id=doc_id, version=version, doc_json=json.dumps(live), actor_id=None
    )
    return version


def mutated_copy(internal, tmp_path, name, *statements):
    """Copy the internal db and run raw SQL against the copy."""
    copy = str(tmp_path / name)
    shutil.copyfile(internal, copy)
    conn = sqlite3.connect(copy)
    for stmt, params in statements:
        conn.execute(stmt, params)
    conn.commit()
    conn.close()
    return copy


def run_cli(*args):
    """Invoke `datasette <args>` (e.g. `run_cli("paper", "export", db, "1")`)."""
    return CliRunner().invoke(cli, list(args))
