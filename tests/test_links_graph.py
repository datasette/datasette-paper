"""Tests for the link graph endpoint.

GET /-/paper/api/links/graph — the actor's viewable subgraph: nodes +
edges restricted to docs the actor can view, never leaking non-viewable
papers. Edges are seeded directly via PaperDB.replace_links. Nodes are
only the docs that PARTICIPATE in a viewable edge (isolated viewable docs
with no links aren't included) — that's intended.
"""

import pytest

from conftest import create_doc, setup_paper_datasette
from datasette_paper.db import PaperDB


@pytest.mark.asyncio
async def test_graph_excludes_non_viewable_nodes_and_edges():
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    a = await create_doc(ds, "Alice A", actor_id="alice")
    b = await create_doc(ds, "Alice B", actor_id="alice")
    c = await create_doc(ds, "Carol C", actor_id="carol")

    # src A → {B, C}; src C → {B}. Only A→B is fully viewable for alice.
    await db.replace_links(src_doc_id=a, src_version=1, edges={b: 1, c: 2})
    await db.replace_links(src_doc_id=c, src_version=1, edges={b: 3})

    resp = await ds.client.get("/-/paper/api/links/graph")
    assert resp.status_code == 200, resp.text
    data = resp.json()

    node_ids = {n["id"] for n in data["nodes"]}
    assert a in node_ids
    assert b in node_ids
    assert c not in node_ids

    edge_pairs = {(e["source"], e["target"]) for e in data["edges"]}
    assert (a, b) in edge_pairs
    assert (a, c) not in edge_pairs
    assert (c, b) not in edge_pairs


@pytest.mark.asyncio
async def test_graph_titles_only_for_viewable():
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    a = await create_doc(ds, "Alice A", actor_id="alice")
    b = await create_doc(ds, "Alice B", actor_id="alice")
    c = await create_doc(ds, "Carol Secret", actor_id="carol")

    await db.replace_links(src_doc_id=a, src_version=1, edges={b: 1, c: 1})
    await db.replace_links(src_doc_id=c, src_version=1, edges={b: 1})

    resp = await ds.client.get("/-/paper/api/links/graph")
    assert resp.status_code == 200, resp.text
    data = resp.json()

    titles_by_id = {n["id"]: n["title"] for n in data["nodes"]}
    assert titles_by_id[a] == "Alice A"
    assert titles_by_id[b] == "Alice B"

    # The non-viewable doc's title must never appear anywhere in the JSON.
    assert "Carol Secret" not in resp.text


@pytest.mark.asyncio
async def test_graph_node_metadata_kind_updated_at_and_tags():
    # @feat link-graph: enriched per-node payload (kind, updated_at, tags)
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    a = await create_doc(ds, "Alice A", actor_id="alice")
    b = await create_doc(ds, "Alice B", actor_id="alice")

    await db.set_doc_tags(doc_id=a, tags=["research", "todo"])
    # b stays untagged.

    await db.replace_links(src_doc_id=a, src_version=1, edges={b: 1})

    resp = await ds.client.get("/-/paper/api/links/graph")
    assert resp.status_code == 200, resp.text
    data = resp.json()

    nodes_by_id = {n["id"]: n for n in data["nodes"]}

    # New keys are present on every node.
    for node in data["nodes"]:
        assert "kind" in node
        assert "updated_at" in node
        assert "tags" in node

    # Tagged doc carries its tags; untagged doc gets an empty list.
    assert sorted(nodes_by_id[a]["tags"]) == ["research", "todo"]
    assert nodes_by_id[b]["tags"] == []

    # kind / updated_at mirror the stored doc rows.
    rows = {r.id: r for r in await db.list_docs_by_ids(doc_ids=[a, b])}
    assert nodes_by_id[a]["kind"] == rows[a].kind
    assert nodes_by_id[a]["updated_at"] == rows[a].updated_at
    assert nodes_by_id[b]["kind"] == rows[b].kind
    assert nodes_by_id[b]["updated_at"] == rows[b].updated_at


@pytest.mark.asyncio
async def test_graph_tags_do_not_leak_non_viewable_docs():
    # A tag on a non-viewable doc must never surface, and the enriched payload
    # must not widen the visible node set beyond edges_within's ACL scope.
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    a = await create_doc(ds, "Alice A", actor_id="alice")
    b = await create_doc(ds, "Alice B", actor_id="alice")
    c = await create_doc(ds, "Carol Secret", actor_id="carol")

    await db.set_doc_tags(doc_id=c, tags=["classified"])

    await db.replace_links(src_doc_id=a, src_version=1, edges={b: 1, c: 1})
    await db.replace_links(src_doc_id=c, src_version=1, edges={b: 1})

    resp = await ds.client.get("/-/paper/api/links/graph")
    assert resp.status_code == 200, resp.text
    data = resp.json()

    node_ids = {n["id"] for n in data["nodes"]}
    assert node_ids == {a, b}
    assert "classified" not in resp.text
    assert "Carol Secret" not in resp.text


@pytest.mark.asyncio
async def test_graph_focus_echoes_isolated_viewable_doc():
    # @feat link-graph: ?focus= echoes an otherwise-isolated viewable doc
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    a = await create_doc(ds, "Alice A", actor_id="alice")
    b = await create_doc(ds, "Alice B", actor_id="alice")
    lonely = await create_doc(ds, "Lonely", actor_id="alice")

    await db.set_doc_tags(doc_id=lonely, tags=["solo"])
    await db.replace_links(src_doc_id=a, src_version=1, edges={b: 1})

    # Without ?focus=, the isolated doc is absent (it participates in no edge).
    resp = await ds.client.get("/-/paper/api/links/graph")
    assert lonely not in {n["id"] for n in resp.json()["nodes"]}

    # With ?focus=, it's echoed as a lone node carrying the enriched keys.
    resp = await ds.client.get(f"/-/paper/api/links/graph?focus={lonely}")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    by_id = {n["id"]: n for n in data["nodes"]}
    assert lonely in by_id
    node = by_id[lonely]
    assert node["title"] == "Lonely"
    assert node["tags"] == ["solo"]
    assert "state" in node and "kind" in node and "updated_at" in node

    # The echo never widens the edge set — the isolated doc has no edges.
    assert all(lonely not in (e["source"], e["target"]) for e in data["edges"])


@pytest.mark.asyncio
async def test_graph_focus_non_viewable_not_echoed():
    # ACL: a focus id the actor can't view is silently ignored, never disclosed.
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    a = await create_doc(ds, "Alice A", actor_id="alice")
    b = await create_doc(ds, "Alice B", actor_id="alice")
    secret = await create_doc(ds, "Carol Secret", actor_id="carol")

    await db.replace_links(src_doc_id=a, src_version=1, edges={b: 1})

    resp = await ds.client.get(f"/-/paper/api/links/graph?focus={secret}")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert secret not in {n["id"] for n in data["nodes"]}
    assert "Carol Secret" not in resp.text


@pytest.mark.asyncio
async def test_graph_focus_absent_or_invalid_ignored():
    # A focus id that doesn't exist, or isn't an integer, is ignored — no error,
    # no change to the payload.
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    a = await create_doc(ds, "Alice A", actor_id="alice")
    b = await create_doc(ds, "Alice B", actor_id="alice")

    await db.replace_links(src_doc_id=a, src_version=1, edges={b: 1})

    baseline_ids = {
        n["id"]
        for n in (await ds.client.get("/-/paper/api/links/graph")).json()["nodes"]
    }

    resp = await ds.client.get("/-/paper/api/links/graph?focus=99999")
    assert resp.status_code == 200
    assert {n["id"] for n in resp.json()["nodes"]} == baseline_ids

    resp = await ds.client.get("/-/paper/api/links/graph?focus=notanid")
    assert resp.status_code == 200
    assert {n["id"] for n in resp.json()["nodes"]} == baseline_ids


@pytest.mark.asyncio
async def test_graph_anonymous_ungated_but_empty():
    # Listing is ungated; an anonymous actor reaches the endpoint but the graph
    # is built from viewable_doc_ids only, so it's empty here.
    ds, _ = await setup_paper_datasette(granted=False, actor=None)

    resp = await ds.client.get("/-/paper/api/links/graph")
    assert resp.status_code == 200
    assert resp.json() == {"nodes": [], "edges": []}
