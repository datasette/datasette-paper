"""Regression tests for the two unbounded-growth paths behind the production OOM.

1. prosemirror-py's global ``ResolvedPos`` cache pinned every intermediate
   doc produced while replaying ``steps_tail`` (see ``pm_compat``).
2. SSE subscriber queues had no cap, so a stream whose peer stopped reading
   accumulated every broadcast forever and kept its instance pinned.
"""

from __future__ import annotations

import asyncio
import gc
import json
import weakref

import pytest
from prosemirror.model import resolvedpos as rp
from prosemirror.transform import Step

import datasette_paper.instance as instance_module
from datasette_paper import pm_compat, sse
from datasette_paper.instance import get_registry
from datasette_paper.pm_schema import schema
from datasette_paper.sse import SSEEvent

from _steps import insert_at  # noqa: E402  (sibling helper)
from test_sse_events import SSEStream, _sse_get  # noqa: E402


def _apply(doc, step_json: str):
    return Step.from_json(schema, json.loads(step_json)).apply(doc).doc


# @feat collab-sse: test: the ResolvedPos cache cannot pin more than a bounded
# number of intermediate docs across step replay
def test_resolve_cache_is_bounded_and_releases_docs():
    assert isinstance(rp._resolve_cache, pm_compat.BoundedResolveCache)
    doc = schema.node_from_json(json.loads(instance_module.empty_doc_json()))
    first = _apply(doc, insert_at(1, "a"))
    first_ref = weakref.ref(first)
    doc = first
    del first
    for i in range(200):
        doc = _apply(doc, insert_at(1, "x"))
    gc.collect()
    assert len(rp._resolve_cache) <= pm_compat.RESOLVE_CACHE_MAX_DOCS
    # Nothing but the cache referenced the early intermediate doc; with the
    # unbounded cache it stayed alive forever.
    assert first_ref() is None


@pytest.mark.asyncio
async def test_write_path_does_not_accumulate_resolve_cache_entries(ds_paper):
    ds, paper_db = ds_paper
    resp = await ds.client.post("/-/paper/api/docs", json={"name": "Doc"})
    doc_id = resp.json()["id"]
    instance = await get_registry(ds).get(paper_db, doc_id)
    for version in range(150):
        await instance.add_events(
            version=version,
            client_id=1,
            actor_id="alice",
            steps=[insert_at(1, "x")],
        )
    gc.collect()
    assert len(rp._resolve_cache) <= pm_compat.RESOLVE_CACHE_MAX_DOCS


@pytest.mark.asyncio
# @feat collab-sse: test: a subscriber that stops draining is dropped with the
# closed sentinel instead of buffering broadcasts without bound
async def test_lagging_subscriber_is_dropped_not_buffered(ds_paper, monkeypatch):
    monkeypatch.setattr(instance_module, "MAX_SUBSCRIBER_QUEUE", 8)
    ds, paper_db = ds_paper
    resp = await ds.client.post("/-/paper/api/docs", json={"name": "Doc"})
    doc_id = resp.json()["id"]
    instance = await get_registry(ds).get(paper_db, doc_id)

    zombie = await instance.subscribe(client_id=7, actor_id="alice")
    healthy = await instance.subscribe(client_id=8, actor_id="alice")
    assert instance.is_pinned

    for i in range(20):
        instance.update_presence(client_id=9, actor_id=None, anchor=i, head=i)
        # Drain the healthy one as a live stream would.
        healthy.get_nowait()

    assert zombie not in instance.subscribers
    assert healthy in instance.subscribers
    assert zombie.qsize() == 1
    assert zombie.get_nowait()["kind"] == SSEEvent.CLOSED

    # Dropping the zombie must not cascade to the healthy subscriber, and the
    # instance is only pinned by streams that still exist.
    instance.unsubscribe(healthy)
    assert not instance.is_pinned


@pytest.mark.asyncio
async def test_revoke_can_close_a_full_queue(ds_paper, monkeypatch):
    monkeypatch.setattr(instance_module, "MAX_SUBSCRIBER_QUEUE", 2)
    ds, paper_db = ds_paper
    resp = await ds.client.post("/-/paper/api/docs", json={"name": "Doc"})
    doc_id = resp.json()["id"]
    instance = await get_registry(ds).get(paper_db, doc_id)
    q = await instance.subscribe(client_id=7, actor_id="mallory")
    q.put_nowait({"kind": SSEEvent.PRESENCE})
    q.put_nowait({"kind": SSEEvent.PRESENCE})
    assert q.full()

    revoked = await instance.revoke_unauthorized(ds)
    assert revoked == 1
    assert q.qsize() == 1
    assert q.get_nowait()["kind"] == SSEEvent.CLOSED


@pytest.mark.asyncio
# @feat collab-sse: test: a peer that stops reading is unsubscribed after the
# send timeout even though no http.disconnect ever arrives
async def test_sse_stalled_peer_is_unsubscribed_after_send_timeout(
    ds_paper, monkeypatch
):
    monkeypatch.setattr(sse, "SEND_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(sse, "HEARTBEAT_SECONDS", 0.05)
    ds, paper_db = ds_paper
    resp = await ds.client.post("/-/paper/api/docs", json={"name": "Doc"})
    doc_id = resp.json()["id"]
    instance = await get_registry(ds).get(paper_db, doc_id)

    original_send = SSEStream._send
    ready_seen = asyncio.Event()

    async def stalling_send(self, message):
        if message.get("body", b"").startswith(b"event: ready\n"):
            ready_seen.set()
        if ready_seen.is_set() and message["type"] == "http.response.body":
            # The peer's socket buffer is full and it never reads again:
            # uvicorn's send would park in flow control exactly like this.
            await asyncio.Event().wait()
        await original_send(self, message)

    monkeypatch.setattr(SSEStream, "_send", stalling_send)
    stream = await _sse_get(
        ds, f"/-/paper/api/docs/{doc_id}/events?version=0&clientID=7"
    )
    await asyncio.wait_for(ready_seen.wait(), timeout=2)
    assert len(instance.subscribers) == 1

    # No disconnect is ever signalled; the handler must give up on its own.
    await asyncio.wait_for(stream._task, timeout=2)
    assert not instance.subscribers
    assert not instance.is_pinned
