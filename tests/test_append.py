"""Tests for the markdown append endpoint (POST /-/paper/api/docs/{id}/append).

Append parses markdown to a ProseMirror fragment and inserts it at the end
of the doc through the same step-log + broadcast pipeline as a collab edit
(see ``Instance.append_fragment``). These cover the route surface; the
parser itself is unit-tested in ``test_markdown_parser.py``.
"""

import asyncio

import pytest

from conftest import create_doc
from datasette_paper.instance import get_registry
from datasette_paper.util import paper_db


async def _document_markdown(ds, doc_id):
    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/document")
    assert resp.status_code == 200
    return resp.json()["content_markdown"]


@pytest.mark.asyncio
async def test_append_to_blank_doc(ds):
    doc_id = await create_doc(ds)
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append",
        json={"content": "# Title\n\nHello **world**.\n"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["appended_blocks"] == 2  # heading + paragraph
    assert body["version"] > 0

    md = await _document_markdown(ds, doc_id)
    assert "# Title" in md
    assert "Hello **world**." in md


@pytest.mark.asyncio
async def test_append_preserves_existing_content(ds):
    doc_id = await create_doc(ds)
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": "First block.\n"}
    )
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": "Second block.\n"}
    )
    md = await _document_markdown(ds, doc_id)
    # Order preserved: first block appears before second.
    assert md.index("First block.") < md.index("Second block.")


@pytest.mark.asyncio
async def test_append_version_advances_by_step(ds):
    doc_id = await create_doc(ds)
    r1 = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": "a\n"}
    )
    r2 = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": "b\n"}
    )
    # Each append is a single ReplaceStep → version increments by one.
    assert r2.json()["version"] == r1.json()["version"] + 1


@pytest.mark.asyncio
async def test_append_rich_content_roundtrips(ds):
    doc_id = await create_doc(ds)
    content = (
        "## Section\n\n"
        "- [ ] todo one\n"
        "- [x] todo done\n\n"
        "| h1 | h2 |\n| --- | --- |\n| a | b |\n\n"
        "```python\nprint('x')\n```\n"
    )
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": content}
    )
    assert resp.status_code == 200
    md = await _document_markdown(ds, doc_id)
    assert "## Section" in md
    assert "- [ ] todo one" in md
    assert "- [x] todo done" in md
    assert "| h1 | h2 |" in md
    assert "print('x')" in md


@pytest.mark.asyncio
async def test_append_inline_and_block_embed_roundtrip(ds):
    """An inline embed and a block embed fence survive the full
    append → step-apply → materialize → serialize path (proves the schema
    lock-step holds end-to-end through the markdown API)."""
    doc_id = await create_doc(ds)
    content = (
        "See [/fixtures/facetable](paper:/embed/datasette/fixtures/facetable) here.\n\n"
        '```paper-embed\n{"config":{},"mode":"table","ref":"/fixtures/facetable"}\n```\n\n'
        '```paper-embed\n{"config":{},"mode":"row","ref":"/fixtures/vendors/42"}\n```\n'
    )
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": content}
    )
    assert resp.status_code == 200
    md = await _document_markdown(ds, doc_id)
    assert "[/fixtures/facetable](paper:/embed/datasette/fixtures/facetable)" in md
    assert (
        '```paper-embed\n{"config":{},"mode":"table","ref":"/fixtures/facetable"}\n```'
        in md
    )
    assert (
        '```paper-embed\n{"config":{},"mode":"row","ref":"/fixtures/vendors/42"}\n```'
        in md
    )


@pytest.mark.asyncio
async def test_append_paper_refs_materialize_with_right_attrs(ds):
    """Ticket 05: an external caller posting the new wire format (a
    paper:/embed inline ref + a paper-embed JSON fence with config) produces a
    materialized doc with the right nodes/attrs — proving the append /
    create-from-markdown path works for the consolidated scheme."""
    doc_id = await create_doc(ds)
    content = (
        "Look [/db/t/row/9](paper:/embed/datasette/db/t/row/9) here.\n\n"
        '```paper-embed\n{"config":{"columns":["a","b"]},"mode":"row","ref":"/db/t"}\n```\n'
    )
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": content}
    )
    assert resp.status_code == 200

    registry = get_registry(ds)
    registry._instances.pop(doc_id, None)
    instance = await registry.get(paper_db(ds), doc_id)
    live = instance.materialize_live_doc()
    flat = []

    def walk(node):
        flat.append(node)
        for c in node.get("content") or []:
            walk(c)

    walk(live)
    inline = [n for n in flat if n.get("type") == "inline_embed"]
    block = [n for n in flat if n.get("type") == "block_embed"]
    assert inline and inline[0]["attrs"]["ref"] == "/db/t/row/9"
    assert block
    assert block[0]["attrs"]["ref"] == "/db/t"
    assert block[0]["attrs"]["mode"] == "row"
    assert block[0]["attrs"]["config"] == {"columns": ["a", "b"]}


@pytest.mark.asyncio
async def test_append_sql_block_roundtrip(ds):
    """A ```sql db=NAME fence survives the full append → step-apply →
    materialize → serialize path (proves the sql_block schema lock-step holds
    end-to-end through the markdown API)."""
    doc_id = await create_doc(ds)
    content = (
        "```sql db=data\nselect 1 as n\n```\n\n"
        "```sql db=data hidden\nselect * from t\n```\n"
    )
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": content}
    )
    assert resp.status_code == 200
    md = await _document_markdown(ds, doc_id)
    assert "```sql db=data\nselect 1 as n\n```" in md
    assert "```sql db=data hidden\nselect * from t\n```" in md


@pytest.mark.asyncio
async def test_apply_markdown_edit_preserves_named_table(ds):
    """Ticket 04: an agent edit runs the whole doc through
    doc_to_markdown -> edit_fn -> markdown_to_doc. A table's `name` attr (used
    by `/tables/{name}` addressing) must survive that round-trip instead of
    being silently dropped."""
    doc_id = await create_doc(ds)
    # Seed a named table via the append endpoint (markdown sidecar form).
    content = '```paper-table\n{"name":"sales"}\n```\n| h |\n| --- |\n| x |\n'
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": content}
    )
    assert resp.status_code == 200

    instance = await get_registry(ds).get(paper_db(ds), doc_id)
    # An agent-style edit that touches unrelated prose; the named table is
    # carried through the (de)serialize untouched.
    await instance.apply_markdown_edit(lambda md: "# Report\n\n" + md)

    live = instance.materialize_live_doc()
    tables = [n for n in live["content"] if n.get("type") == "table"]
    assert len(tables) == 1
    assert tables[0]["attrs"]["name"] == "sales"

    # And the name is still addressable through the /tables/{name} endpoint.
    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/tables/sales")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_append_empty_markdown_is_noop(ds):
    doc_id = await create_doc(ds)
    # Bump the version once so we can assert it doesn't move.
    r1 = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": "seed\n"}
    )
    before = r1.json()["version"]

    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": "   \n\n"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["appended_blocks"] == 0
    assert body["version"] == before


@pytest.mark.asyncio
async def test_append_missing_content_is_400(ds):
    doc_id = await create_doc(ds)
    resp = await ds.client.post(f"/-/paper/api/docs/{doc_id}/append", json={})
    assert resp.status_code == 400
    assert "content" in resp.json()["error"]


@pytest.mark.asyncio
async def test_append_non_string_content_is_400(ds):
    doc_id = await create_doc(ds)
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": ["not", "a", "string"]}
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_append_unsupported_content_type_is_400(ds):
    doc_id = await create_doc(ds)
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append",
        json={"content": "x\n", "content_type": "html"},
    )
    assert resp.status_code == 400
    assert "content_type" in resp.json()["error"]


@pytest.mark.asyncio
async def test_append_to_missing_doc_is_forbidden(ds):
    # The per-paper edit gate fires before the existence check, so a doc the
    # actor can't prove edit rights on (here: one that doesn't exist, so no acl
    # grant matches) is denied with 403 — same as every other per-paper
    # endpoint, and it avoids leaking which doc ids exist.
    resp = await ds.client.post(
        "/-/paper/api/docs/99999/append", json={"content": "x\n"}
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_append_broadcasts_to_live_subscribers(ds):
    """A live SSE subscriber receives the appended step as an update."""
    from datasette_paper.util import paper_db

    doc_id = await create_doc(ds)
    instance = await get_registry(ds).get(paper_db(ds), doc_id)
    queue = await instance.subscribe(client_id=12345, actor_id="alice")

    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": "broadcast me\n"}
    )
    assert resp.status_code == 200

    payload = await asyncio.wait_for(queue.get(), timeout=1)
    assert payload["kind"] == "update"
    # API-originated steps use the sentinel client_id (-1), never a real one,
    # so the subscriber is not skipped.
    assert payload["clientIDs"] == [-1]
    assert payload["version"] == resp.json()["version"]


@pytest.mark.asyncio
async def test_append_auto_snapshots_past_threshold(ds, monkeypatch):
    """API-only docs (no browser to POST /snapshot) must still snapshot, or
    their step tail grows without bound. Drop the threshold and confirm a
    snapshot lands and the tail is trimmed."""
    import datasette_paper.instance as inst_mod
    from datasette_paper.util import paper_db

    monkeypatch.setattr(inst_mod, "SNAPSHOT_THRESHOLD", 2)

    doc_id = await create_doc(ds)
    db = paper_db(ds)
    instance = await get_registry(ds).get(db, doc_id)
    assert instance.snapshot_version == 0

    for i in range(3):
        resp = await ds.client.post(
            f"/-/paper/api/docs/{doc_id}/append", json={"content": f"line {i}\n"}
        )
        assert resp.status_code == 200

    # A snapshot row was written server-side, with no POST /snapshot involved.
    assert instance.snapshot_version >= 2
    snap = await db.select_latest_snapshot(doc_id=doc_id)
    assert snap is not None
    assert snap.version == instance.snapshot_version
    # Steps at/below the snapshot are evicted from the in-memory tail.
    assert all(s["version"] > instance.snapshot_version for s in instance.steps_tail)


@pytest.mark.asyncio
async def test_append_denied_without_edit_permission():
    """A viewer-only actor (acl Viewer grant) can't append."""
    from datasette.app import Datasette
    from datasette_acl.grants import grant, Principal
    from datasette_paper.permissions import (
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
    )
    from datasette_paper.util import paper_db

    ds = Datasette(
        memory=True,
        config={
            "permissions": {
                "datasette-paper-create": True,
            }
        },
    )
    await ds.invoke_startup()
    alice = {"ds_actor": ds.sign({"a": {"id": "alice"}}, "actor")}
    bob = {"ds_actor": ds.sign({"a": {"id": "bob"}}, "actor")}

    # Alice creates a doc and grants bob view-only via acl.
    created = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Alice"}, cookies=alice
    )
    doc_id = created.json()["id"]
    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.actor("bob"),
        role="Viewer",
        by_actor="alice",
    )

    # Bob can view but not append.
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append",
        json={"content": "sneaky\n"},
        cookies=bob,
    )
    assert resp.status_code == 403

    # And the doc is unchanged.
    instance = await get_registry(ds).get(paper_db(ds), doc_id)
    assert instance.version == 0
