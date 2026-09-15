"""Tests for datasette_paper.instance and datasette_paper.errors."""

from __future__ import annotations

import asyncio

import pytest

from datasette_paper.errors import (
    BadVersionError,
    ConflictError,
    GoneError,
    InvalidStepError,
)
import datasette_paper.instance as instance_module
from datasette_paper.instance import Instance, InstanceRegistry

import json

from _steps import insert_at, insert_sequence  # noqa: E402  (sibling helper)


@pytest.mark.asyncio
async def test_hydrate_empty_doc(ds_paper):
    _, db = ds_paper
    doc = await db.insert_doc(name="Test Doc")

    inst = await Instance.hydrate(db, doc.id)

    assert inst.version == 0
    assert inst.snapshot_version == 0
    assert inst.snapshot_doc_json == instance_module.empty_doc_json()
    assert len(inst.steps_tail) == 0


@pytest.mark.asyncio
async def test_add_events_increments_version(ds_paper):
    _, db = ds_paper
    doc = await db.insert_doc(name="Test Doc")

    inst = await Instance.hydrate(db, doc.id)

    # Two valid single-char inserts (".." at the start of the empty doc).
    # `Instance.add_events` now validates each step against the live doc
    # before writing; bare {"stepType": "replace"} fails to parse.
    steps = insert_sequence(1, "..")
    new_ver = await inst.add_events(
        version=0,
        client_id=42,
        actor_id="alice",
        steps=steps,
    )

    assert new_ver == 2
    assert inst.version == 2
    assert len(inst.steps_tail) == 2

    db_doc = await db.select_doc_by_id(doc.id)
    assert db_doc is not None
    assert db_doc.current_version == 2


@pytest.mark.asyncio
async def test_add_events_conflict_raises(ds_paper):
    _, db = ds_paper
    doc = await db.insert_doc(name="Test Doc")

    inst = await Instance.hydrate(db, doc.id)

    await inst.add_events(
        version=0,
        client_id=1,
        actor_id=None,
        steps=[insert_at(1)],
    )

    # The version-check raises *before* step validation runs, so even a
    # would-be-valid step still produces ConflictError / BadVersionError.
    with pytest.raises(ConflictError):
        await inst.add_events(
            version=0,
            client_id=1,
            actor_id=None,
            steps=[insert_at(2)],
        )

    with pytest.raises(BadVersionError):
        await inst.add_events(
            version=999,
            client_id=1,
            actor_id=None,
            steps=[insert_at(2)],
        )


@pytest.mark.asyncio
async def test_get_events_too_old_gone(ds_paper, monkeypatch):
    monkeypatch.setattr(instance_module, "MAX_TAIL", 2)

    _, db = ds_paper
    doc = await db.insert_doc(name="Test Doc")

    inst = await Instance.hydrate(db, doc.id)

    for _ in range(4):
        # Always insert at position 1 (start of the paragraph) — this is
        # position-stable across the MAX_TAIL=2 eviction, so the live-doc
        # materialization can lose old steps and still produce a valid
        # apply target.
        await inst.add_events(
            version=inst.version,
            client_id=1,
            actor_id=None,
            steps=[insert_at(1)],
        )

    assert inst.version == 4
    assert len(inst.steps_tail) == 2

    with pytest.raises(GoneError):
        inst.get_events(since_version=0)

    with pytest.raises(GoneError):
        inst.get_events(since_version=1)

    result = inst.get_events(since_version=3)
    assert result is not None
    assert result["version"] == 4
    assert len(result["steps"]) == 1


@pytest.mark.asyncio
async def test_subscribe_receives_broadcast(ds_paper):
    _, db = ds_paper
    doc = await db.insert_doc(name="Test Doc")

    inst = await Instance.hydrate(db, doc.id)

    q = await inst.subscribe()

    await inst.add_events(
        version=0,
        client_id=7,
        actor_id="bob",
        steps=[insert_at(1, "Z")],
    )

    payload = await asyncio.wait_for(q.get(), timeout=1.0)

    assert payload["version"] == 1
    assert len(payload["steps"]) == 1
    # Steps ship in the broadcast as parsed objects, not JSON strings.
    assert payload["steps"][0]["stepType"] == "replace"
    assert payload["steps"][0]["slice"]["content"][0]["text"] == "Z"
    assert payload["clientIDs"][0] == 7

    inst.unsubscribe(q)
    assert q not in inst.subscribers


@pytest.mark.asyncio
async def test_materialize_live_doc_applies_pending_steps(ds_paper):
    """Regression for the bug where /document returned an empty body for
    short docs that hadn't yet hit the 100-step snapshot threshold."""
    _, db = ds_paper
    doc = await db.insert_doc(name="Live Doc")
    inst = await Instance.hydrate(db, doc.id)

    insert_h = {
        "stepType": "replace",
        "from": 1,
        "to": 1,
        "slice": {"content": [{"type": "text", "text": "H"}]},
    }
    insert_i = {
        "stepType": "replace",
        "from": 2,
        "to": 2,
        "slice": {"content": [{"type": "text", "text": "i"}]},
    }
    await inst.add_events(
        version=0,
        client_id=42,
        actor_id=None,
        steps=[insert_h, insert_i],
    )

    assert inst.snapshot_version == 0
    assert "Hi" not in inst.snapshot_doc_json

    live = inst.materialize_live_doc()
    assert live["type"] == "doc"
    para = live["content"][0]
    assert para["type"] == "paragraph"
    assert para["content"][0]["text"] == "Hi"


@pytest.mark.asyncio
async def test_materialize_live_doc_caches_until_version_changes(ds_paper):
    _, db = ds_paper
    doc = await db.insert_doc(name="Cache Doc")
    inst = await Instance.hydrate(db, doc.id)

    first = inst.materialize_live_doc()
    second = inst.materialize_live_doc()
    assert first == second
    assert inst._cached_live_version == inst.version

    insert = {
        "stepType": "replace",
        "from": 1,
        "to": 1,
        "slice": {"content": [{"type": "text", "text": "X"}]},
    }
    await inst.add_events(
        version=0,
        client_id=1,
        actor_id=None,
        steps=[insert],
    )
    third = inst.materialize_live_doc()
    assert third != first
    assert inst._cached_live_version == inst.version


@pytest.mark.asyncio
async def test_add_events_rejects_when_history_is_poisoned(ds_paper):
    """A step in history that won't apply taints the materialized doc;
    the cached partial doc is stamped with the full version count, so
    client-side steps positioned against the latest state can't be
    validated. Reject new writes with a `history corrupted` marker
    rather than letting each step fail with the misleading underlying
    position / content error."""
    _, db = ds_paper
    doc = await db.insert_doc(name="Poisoned")

    # Plant a step at v=1 that fails on the empty doc. Inserting a text
    # node at position 0 (between the doc node and its paragraph child)
    # tries to make `<text, paragraph>` the doc's content — which
    # violates `block+` and raises ValueError from check_content. Same
    # error class the user hit in the wild: "Invalid content for node doc".
    bad_step = json.dumps(
        {
            "stepType": "replace",
            "from": 0,
            "to": 0,
            "slice": {"content": [{"type": "text", "text": "x"}]},
        }
    )
    await db.insert_step(
        doc_id=doc.id,
        client_id=1,
        actor_id=None,
        step_json=bad_step,
    )

    inst = await Instance.hydrate(db, doc.id)
    assert inst.version == 1

    # Materialization breaks at v=1 and records the failure.
    inst.materialize_live_doc()
    assert inst._materialization_error is not None
    bad_version, _ = inst._materialization_error
    assert bad_version == 1

    # add_events rejects with a clear history-corrupted message before
    # touching the DB.
    with pytest.raises(InvalidStepError) as exc_info:
        await inst.add_events(
            version=1,
            client_id=2,
            actor_id=None,
            steps=[insert_at(1, "y")],
        )
    assert "history corrupted" in exc_info.value.message
    assert "version 1" in exc_info.value.message
    assert exc_info.value.step_index == 0

    # And no new step was written.
    assert inst.version == 1
    assert len(inst.steps_tail) == 1


@pytest.mark.asyncio
async def test_materialize_clears_error_when_history_becomes_clean(ds_paper):
    """If the bad step is trimmed and the instance re-hydrated, the
    `_materialization_error` gate clears on the next materialization
    so writes can resume."""
    _, db = ds_paper
    doc = await db.insert_doc(name="Repairable")

    bad_step = json.dumps(
        {
            "stepType": "replace",
            "from": 0,
            "to": 0,
            "slice": {"content": [{"type": "text", "text": "x"}]},
        }
    )
    await db.insert_step(
        doc_id=doc.id,
        client_id=1,
        actor_id=None,
        step_json=bad_step,
    )

    inst = await Instance.hydrate(db, doc.id)
    inst.materialize_live_doc()
    assert inst._materialization_error is not None

    # Simulate an admin trimming the bad step from the tail. The cache
    # has to drop so the loop re-runs against the clean tail.
    inst.steps_tail.clear()
    inst._cached_live_doc_json = None
    inst._cached_live_version = None

    inst.materialize_live_doc()
    assert inst._materialization_error is None


@pytest.mark.asyncio
async def test_registry_evicts_lru(ds_paper, monkeypatch):
    monkeypatch.setattr(instance_module, "MAX_INSTANCES", 2)

    _, db = ds_paper

    registry = InstanceRegistry()

    doc1 = await db.insert_doc(name="Doc 1")
    doc2 = await db.insert_doc(name="Doc 2")
    doc3 = await db.insert_doc(name="Doc 3")

    await registry.get(db, doc1.id)
    await registry.get(db, doc2.id)
    await registry.get(db, doc3.id)

    assert len(registry._instances) == 2
    assert doc1.id not in registry._instances
    assert doc2.id in registry._instances
    assert doc3.id in registry._instances


@pytest.mark.asyncio
async def test_concurrent_registry_loads_share_instance_and_write_lock(
    ds_paper, monkeypatch
):
    _, db = ds_paper
    doc = await db.insert_doc(name="Concurrent load")
    registry = InstanceRegistry()
    hydrate_started = asyncio.Event()
    release_hydrate = asyncio.Event()
    second_started = asyncio.Event()
    original_hydrate = Instance.hydrate

    async def paused_hydrate(cls, db, doc_id):
        hydrate_started.set()
        await release_hydrate.wait()
        return await original_hydrate(db, doc_id)

    monkeypatch.setattr(Instance, "hydrate", classmethod(paused_hydrate))
    first_load = asyncio.create_task(registry.get(db, doc.id))
    await hydrate_started.wait()

    async def second_load():
        second_started.set()
        return await registry.get(db, doc.id)

    second_load_task = asyncio.create_task(second_load())
    await second_started.wait()
    release_hydrate.set()
    first, second = await asyncio.gather(first_load, second_load_task)
    assert first is second

    # Simultaneous writers must check the same live version under one lock.
    # Independent instances would both accept steps positioned at version 0.
    subscriber = await first.subscribe()
    results = await asyncio.gather(
        first.add_events(0, 1, "alice", [insert_at(1, "A")]),
        second.add_events(0, 2, "bob", [insert_at(1, "B")]),
        return_exceptions=True,
    )
    assert sum(isinstance(result, ConflictError) for result in results) == 1
    assert first.version == 1
    assert subscriber.qsize() == 1
    rehydrated = await Instance.hydrate(db, doc.id)
    assert rehydrated.materialize_live_doc() == first.materialize_live_doc()


@pytest.mark.asyncio
async def test_registry_preserves_live_subscribers_under_cache_pressure(
    ds_paper, monkeypatch
):
    monkeypatch.setattr(instance_module, "MAX_INSTANCES", 1)
    _, db = ds_paper
    doc1 = await db.insert_doc(name="Open editor")
    doc2 = await db.insert_doc(name="Another document")
    registry = InstanceRegistry()
    first = await registry.get(db, doc1.id)
    subscriber = await first.subscribe(client_id=1)

    await registry.get(db, doc2.id)
    writer = await registry.get(db, doc1.id)
    await writer.add_events(0, 2, "bob", [insert_at(1, "B")])

    assert subscriber.qsize() == 1
    assert writer is first
    assert subscriber.get_nowait()["version"] == 1

    # Once the editor disconnects, the document is eligible for eviction.
    first.unsubscribe(subscriber)
    await registry.get(db, doc2.id)
    assert doc1.id not in registry._instances
    assert len(registry._instances) == 1


@pytest.mark.asyncio
async def test_registry_preserves_inflight_writes_under_cache_pressure(
    ds_paper, monkeypatch
):
    monkeypatch.setattr(instance_module, "MAX_INSTANCES", 1)
    _, db = ds_paper
    doc1 = await db.insert_doc(name="Write in flight")
    doc2 = await db.insert_doc(name="Another document")
    registry = InstanceRegistry()
    first = await registry.get(db, doc1.id)
    write_started = asyncio.Event()
    release_write = asyncio.Event()
    original_write = first._persist_and_broadcast

    async def paused_write(*args):
        write_started.set()
        await release_write.wait()
        return await original_write(*args)

    monkeypatch.setattr(first, "_persist_and_broadcast", paused_write)
    writer = asyncio.create_task(first.add_events(0, 1, "alice", [insert_at(1, "A")]))
    await write_started.wait()
    try:
        await registry.get(db, doc2.id)
        second = await registry.get(db, doc1.id)
        assert second is first
    finally:
        release_write.set()
        await writer

    with pytest.raises(ConflictError):
        await second.add_events(0, 2, "bob", [insert_at(1, "B")])


@pytest.mark.asyncio
async def test_registry_reuses_evicted_instance_still_held_by_a_caller(
    ds_paper, monkeypatch
):
    monkeypatch.setattr(instance_module, "MAX_INSTANCES", 1)
    _, db = ds_paper
    doc1 = await db.insert_doc(name="Caller about to write")
    doc2 = await db.insert_doc(name="Another document")
    registry = InstanceRegistry()
    first = await registry.get(db, doc1.id)
    await registry.get(db, doc2.id)
    assert doc1.id not in registry._instances

    # A caller can retain an instance without holding its write lock yet.
    # Reusing the doc while that caller is suspended must not create a
    # second authority that lets its stale version-0 write through later.
    second = await registry.get(db, doc1.id)
    await second.add_events(0, 2, "bob", [insert_at(1, "B")])
    with pytest.raises(ConflictError):
        await first.add_events(0, 1, "alice", [insert_at(1, "A")])
    assert first.materialize_live_doc() == second.materialize_live_doc()


@pytest.mark.asyncio
async def test_registry_retries_after_failed_hydrate(ds_paper, monkeypatch):
    _, db = ds_paper
    doc = await db.insert_doc(name="Flaky hydrate")
    registry = InstanceRegistry()
    original_hydrate = Instance.hydrate
    calls = 0

    async def flaky_hydrate(cls, db, doc_id):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("db hiccup")
        return await original_hydrate(db, doc_id)

    monkeypatch.setattr(Instance, "hydrate", classmethod(flaky_hydrate))
    with pytest.raises(RuntimeError):
        await registry.get(db, doc.id)
    # The failed in-flight hydrate must not be memoized.
    inst = await registry.get(db, doc.id)
    assert inst.doc_id == doc.id
    assert not registry._hydrating


@pytest.mark.asyncio
async def test_registry_cancelled_caller_does_not_cancel_shared_hydrate(
    ds_paper, monkeypatch
):
    _, db = ds_paper
    doc = await db.insert_doc(name="Cancelled caller")
    registry = InstanceRegistry()
    started = asyncio.Event()
    release = asyncio.Event()
    original_hydrate = Instance.hydrate

    async def paused_hydrate(cls, db, doc_id):
        started.set()
        await release.wait()
        return await original_hydrate(db, doc_id)

    monkeypatch.setattr(Instance, "hydrate", classmethod(paused_hydrate))
    doomed = asyncio.create_task(registry.get(db, doc.id))
    await started.wait()
    survivor = asyncio.create_task(registry.get(db, doc.id))
    await asyncio.sleep(0)
    # A client disconnect cancels one request mid-hydrate.
    doomed.cancel()
    release.set()
    inst = await asyncio.wait_for(survivor, timeout=5)
    assert inst.doc_id == doc.id
    assert registry._instances[doc.id] is inst


@pytest.mark.parametrize(
    ("error", "status"),
    [(ConflictError, 409), (BadVersionError, 400), (GoneError, 410)],
)
def test_protocol_errors_carry_http_status(error, status):
    exc = error("detail")
    assert exc.status == status
    assert str(exc) == "detail"
    assert str(error()) == error.reason
    assert InvalidStepError(2, "boom").status == 422
