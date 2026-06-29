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
async def test_graph_anonymous_ungated_but_empty():
    # Listing is ungated; an anonymous actor reaches the endpoint but the graph
    # is built from viewable_doc_ids only, so it's empty here.
    ds, _ = await setup_paper_datasette(granted=False, actor=None)

    resp = await ds.client.get("/-/paper/api/links/graph")
    assert resp.status_code == 200
    assert resp.json() == {"nodes": [], "edges": []}
