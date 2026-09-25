"""Regression tests for the two unbounded-growth paths behind the production OOM.

1. prosemirror-py's global ``ResolvedPos`` cache pinned every intermediate
   doc produced while replaying ``steps_tail`` (see ``pm_compat``).
2. SSE subscriber queues had no cap, so a stream whose peer stopped reading
   accumulated every broadcast forever and kept its instance pinned.

Plus the multiplier behind (1): every write used to rebuild the live doc
from the snapshot and replay the whole tail. The live doc is now advanced
incrementally; the tests at the bottom pin that and its correctness edges.
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
from datasette_paper.errors import InvalidStepError
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
        instance.update_presence(client_id=8, actor_id=None, anchor=i, head=i)
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


async def _new_instance(ds, paper_db):
    resp = await ds.client.post("/-/paper/api/docs", json={"name": "Doc"})
    doc_id = resp.json()["id"]
    return await get_registry(ds).get(paper_db, doc_id)


def _count_rebuilds(monkeypatch) -> list:
    """Count full live-doc rebuilds (each one parses a whole snapshot doc).

    Step slices go through ``node_from_json`` too, so only doc nodes count.
    """
    calls: list = []
    original = schema.node_from_json

    def spy(json_data):
        if json_data.get("type") == "doc":
            calls.append(1)
        return original(json_data)

    monkeypatch.setattr(schema, "node_from_json", spy)
    return calls


@pytest.mark.asyncio
# @feat snapshot-log: test: writes advance the live doc incrementally — no
# snapshot + tail replay per write, including across auto-snapshots
async def test_writes_do_not_rebuild_live_doc(ds_paper, monkeypatch):
    monkeypatch.setattr(instance_module, "SNAPSHOT_THRESHOLD", 5)
    ds, paper_db = ds_paper
    instance = await _new_instance(ds, paper_db)
    instance.materialize_live_doc()  # the one hydrate-time rebuild
    rebuilds = _count_rebuilds(monkeypatch)
    materializes: list = []
    original_materialize = instance.materialize_live_doc

    def spy_materialize():
        materializes.append(1)
        return original_materialize()

    monkeypatch.setattr(instance, "materialize_live_doc", spy_materialize)

    for version in range(23):
        await instance.add_events(
            version=version, client_id=1, actor_id="alice", steps=[insert_at(1, "x")]
        )
    assert instance.snapshot_version == 20
    assert rebuilds == []
    # The write tail shares one read-only materialization across the three
    # reindexers instead of each one parsing the cached JSON.
    assert materializes == []
    text = original_materialize()["content"][0]["content"][0]["text"]
    assert text == "x" * 23


@pytest.mark.asyncio
async def test_incremental_live_doc_matches_fresh_hydrate(ds_paper, monkeypatch):
    monkeypatch.setattr(instance_module, "SNAPSHOT_THRESHOLD", 4)
    ds, paper_db = ds_paper
    instance = await _new_instance(ds, paper_db)
    for i in range(6):
        await instance.add_events(
            version=instance.version,
            client_id=1,
            actor_id="alice",
            steps=[insert_at(1, "ab"), insert_at(3, str(i))],
        )
        await instance.append_fragment(
            [{"type": "paragraph", "content": [{"type": "text", "text": f"p{i}"}]}]
        )
    await instance.apply_markdown_edit(lambda md: md.replace("p3", "P3"))

    fresh = await instance_module.Instance.hydrate(paper_db, instance.doc_id)
    assert fresh.version == instance.version
    expected = fresh.materialize_live_doc()
    assert "P3" in json.dumps(expected)
    assert instance.materialize_live_doc() == expected
    # The incremental node itself (not just its cached JSON) agrees too.
    instance._cached_live_doc_json = None
    assert instance.materialize_live_doc() == expected


@pytest.mark.asyncio
async def test_failed_or_rejected_write_leaves_live_doc(ds_paper, monkeypatch):
    ds, paper_db = ds_paper
    instance = await _new_instance(ds, paper_db)
    await instance.add_events(
        version=0, client_id=1, actor_id="alice", steps=[insert_at(1, "a")]
    )
    before = instance.materialize_live_doc()

    # Validation fails on the second step: nothing leaks from the first.
    with pytest.raises(InvalidStepError):
        await instance.add_events(
            version=1,
            client_id=1,
            actor_id="alice",
            steps=[insert_at(1, "b"), insert_at(999, "c")],
        )
    assert instance.materialize_live_doc() == before

    # The DB write fails after validation succeeded.
    async def boom(fn):
        raise RuntimeError("disk full")

    with monkeypatch.context() as m:
        m.setattr(instance.db.database, "execute_write_fn", boom)
        with pytest.raises(RuntimeError):
            await instance.add_events(
                version=1, client_id=1, actor_id="alice", steps=[insert_at(1, "b")]
            )
    assert instance.version == 1
    assert instance.materialize_live_doc() == before

    await instance.add_events(
        version=1, client_id=1, actor_id="alice", steps=[insert_at(2, "z")]
    )
    fresh = await instance_module.Instance.hydrate(paper_db, instance.doc_id)
    assert fresh.materialize_live_doc() == instance.materialize_live_doc()
    assert instance.materialize_live_doc()["content"][0]["content"][0]["text"] == "az"


@pytest.mark.asyncio
async def test_materialized_doc_is_a_private_copy(ds_paper):
    ds, paper_db = ds_paper
    instance = await _new_instance(ds, paper_db)
    await instance.append_fragment(
        [
            {
                "type": "heading",
                "attrs": {"level": 2},
                "content": [{"type": "text", "text": "H"}],
            }
        ]
    )
    live = instance.materialize_live_doc()
    live["content"][1]["attrs"]["level"] = 6
    live["content"].clear()
    again = instance.materialize_live_doc()
    assert again["content"][1]["attrs"]["level"] == 2
    instance._cached_live_doc_json = None  # re-derive from the node
    assert instance.materialize_live_doc() == again
