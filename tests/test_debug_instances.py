"""Tests for the root-only GET /-/paper/api/debug/instances."""

from __future__ import annotations

import pytest

from datasette_paper.instance import get_registry

from conftest import actor_cookie, create_doc
from test_sse_events import _post_step

URL = "/-/paper/api/debug/instances"


@pytest.mark.asyncio
async def test_root_sees_hot_instance_state(ds_paper):
    ds, paper_db = ds_paper
    ds.root_enabled = True
    doc_id = await create_doc(ds)
    await _post_step(ds, doc_id, 0)
    instance = await get_registry(ds).get(paper_db, doc_id)
    instance.materialize_live_doc()
    # An undrained subscriber: the presence broadcast stays in its queue.
    q = await instance.subscribe(client_id=9, actor_id="alice")
    instance.update_presence(client_id=9, actor_id="alice", anchor=1, head=1)

    resp = await ds.client.get(URL, cookies=actor_cookie(ds, "root"))
    instance.unsubscribe(q)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    [report] = [r for r in body["instances"] if r["doc_id"] == doc_id]
    assert report["version"] == 1
    assert report["subscribers"] == 1
    assert report["queue_sizes"] == [1]
    assert report["steps_tail"] == 1
    assert report["presence"] == 1
    assert report["is_pinned"] is True
    assert report["cached_doc_bytes"] > 0
    assert isinstance(body["resolve_cache_entries"], int)
    assert "rss_bytes" in body
    assert body["peak_rss_bytes"] is None or body["peak_rss_bytes"] > 0


@pytest.mark.asyncio
@pytest.mark.parametrize("actor", ["alice", None])
async def test_non_root_is_denied(ds, actor):
    ds.root_enabled = True
    await create_doc(ds)
    cookies = actor_cookie(ds, actor) if actor else {"ds_actor": ""}
    resp = await ds.client.get(URL, cookies=cookies)
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_root_is_denied_without_root_enabled(ds):
    # The ``root`` actor only holds permissions when datasette runs with --root.
    resp = await ds.client.get(URL, cookies=actor_cookie(ds, "root"))
    assert resp.status_code == 403
