"""Multiplayer simulation tests for ``Instance.add_events`` and SSE subscribe.

These tests exercise concurrency scenarios that the per-test fixtures in
``test_post_events.py`` / ``test_sse_events.py`` don't — specifically,
two coroutines hitting the same Instance at the same version
simultaneously. Before the ``_write_lock`` fix in ``instance.py``, both
calls could pass the version check, both validate against the same
pre-write doc, and the second one's step would land on top of the first
one's. That produced a tail with duplicate versions, double-broadcasts,
and (when the steps' positions interacted) a step that failed to replay
on hydrate — surfacing as the "ask an admin to fix" banner in the
client.

The tests in this file operate at the ``Instance`` layer (not the HTTP
layer) so we can directly schedule concurrent ``add_events`` calls and
make assertions about the resulting tail / hydrate replay.

Coverage:
    - Two concurrent add_events at the same version → exactly one
      succeeds, the other gets ConflictError. Tail has no duplicates.
    - Concurrent paste vs. typing → server's doc remains replayable.
    - SSE subscribe_with_backlog → no event is lost when an
      add_events fires between subscribe and the response start.
    - N-client typing fuzz with retries → after quiescence, the doc
      contains every client's contribution and rehydrates cleanly.
"""

from __future__ import annotations

import asyncio
import json
import random

import pytest

from datasette_paper.errors import ConflictError
from datasette_paper.instance import Instance, get_registry

from _steps import insert_at  # noqa: E402  (sibling helper)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_instance(ds_paper) -> tuple[Instance, int]:
    """Create a doc, hydrate its Instance, return (instance, doc_id)."""
    ds, db = ds_paper
    doc = await db.insert_doc(name="sim")
    inst = await Instance.hydrate(db, doc.id)
    # Pin it in the registry so any code that calls registry.get() (e.g.
    # the SSE route) sees the same instance we're driving directly.
    get_registry(ds)._instances[doc.id] = inst
    return inst, doc.id


def _materialize_text(inst: Instance) -> str:
    """Flatten the live doc's text nodes into one string for assertions."""
    doc = inst.materialize_live_doc()
    chunks: list[str] = []

    def walk(node):
        if node.get("type") == "text":
            chunks.append(node.get("text", ""))
            return
        for child in node.get("content", []) or []:
            walk(child)

    walk(doc)
    return "".join(chunks)


# ---------------------------------------------------------------------------
# The bug: two concurrent add_events at the same version
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_add_events_at_same_version_serializes(ds_paper):
    """Two clients both POST steps at version=0. Exactly one of them
    must succeed; the other must see ConflictError. The tail must not
    contain duplicate versions, and the doc must hydrate cleanly.

    Pre-lock behavior: both calls passed the version check (each saw
    ``self.version == 0`` because the first hadn't advanced it yet),
    both validated against the same pre-write doc, and both wrote —
    the second one's step landing at v=2 on top of the first's v=1
    despite being validated against pre-v=1 state.
    """
    inst, _ = await _make_instance(ds_paper)

    async def post(client_id: int, char: str):
        try:
            return await inst.add_events(
                version=0,
                client_id=client_id,
                actor_id=None,
                steps=[insert_at(1, char)],
            )
        except ConflictError:
            return None

    results = await asyncio.gather(post(1, "A"), post(2, "B"))

    # Exactly one succeeded, one returned None (ConflictError).
    succeeded = [r for r in results if r is not None]
    failed = [r for r in results if r is None]
    assert len(succeeded) == 1, f"Expected exactly one success, got {results}"
    assert len(failed) == 1

    # Tail has exactly one step at v=1, no duplicates.
    assert len(inst.steps_tail) == 1
    assert inst.steps_tail[0]["version"] == 1
    assert inst.version == 1

    # Doc replays cleanly.
    inst.materialize_live_doc()
    assert inst._materialization_error is None


@pytest.mark.asyncio
async def test_concurrent_add_events_dont_double_broadcast(ds_paper):
    """The race used to produce broadcasts where the second client's
    payload included BOTH steps (because select_steps_after returned
    the first client's step too). Subscribers ended up applying v=1
    twice. After the lock, each client's broadcast contains only its
    own steps.
    """
    inst, _ = await _make_instance(ds_paper)
    # Watcher subscribes with a third clientID so neither write filters
    # it out as the originator.
    watcher = await inst.subscribe(client_id=999)

    async def post(client_id: int, char: str):
        try:
            await inst.add_events(
                version=0,
                client_id=client_id,
                actor_id=None,
                steps=[insert_at(1, char)],
            )
        except ConflictError:
            pass

    await asyncio.gather(post(1, "A"), post(2, "B"))

    # Drain the watcher's queue. We expect exactly one broadcast (only
    # one writer won the version race).
    payloads = []
    while not watcher.empty():
        payloads.append(watcher.get_nowait())

    update_payloads = [p for p in payloads if p["kind"] == "update"]
    assert len(update_payloads) == 1, (
        f"Expected 1 update broadcast, got {len(update_payloads)}: {update_payloads}"
    )
    # The single broadcast contains exactly one step.
    assert len(update_payloads[0]["steps"]) == 1
    assert len(update_payloads[0]["clientIDs"]) == 1
    # And the clientIDs list aligns with the steps list — no leakage of
    # the other writer's clientID under the wrong step.
    assert update_payloads[0]["clientIDs"][0] in (1, 2)


# ---------------------------------------------------------------------------
# Replay safety: rehydrate must reproduce live materialization
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_writes_rehydrate_matches_live(ds_paper):
    """Bombard the instance with concurrent edits (each retrying on
    409). After quiescence, dropping the in-memory state and
    re-hydrating from the DB must give the same materialized doc.
    """
    _ds, db = ds_paper
    inst, doc_id = await _make_instance(ds_paper)

    async def writer(client_id: int, char: str, n: int):
        for _ in range(n):
            while True:
                try:
                    await inst.add_events(
                        version=inst.version,
                        client_id=client_id,
                        actor_id=None,
                        # Always insert at pos=1 (start of paragraph) so
                        # every step validates regardless of who landed
                        # what before it.
                        steps=[insert_at(1, char)],
                    )
                    break
                except ConflictError:
                    # Race lost — retry at the new version.
                    await asyncio.sleep(0)

    await asyncio.gather(
        writer(1, "A", 20),
        writer(2, "B", 20),
        writer(3, "C", 20),
    )

    # Live doc materializes cleanly.
    live_before = inst.materialize_live_doc()
    assert inst._materialization_error is None

    # Drop the cached instance, rehydrate from DB.
    get_registry(_ds)._instances.pop(doc_id, None)
    fresh = await Instance.hydrate(db, doc_id)
    live_after = fresh.materialize_live_doc()
    assert fresh._materialization_error is None

    assert live_before == live_after

    # Every writer contributed at least once. (Each iteration inserts
    # exactly one char, so 60 chars total — the count test exercises
    # the no-step-lost property.)
    text = _materialize_text(fresh)
    assert len(text) == 60
    assert "A" in text and "B" in text and "C" in text


@pytest.mark.asyncio
async def test_concurrent_paste_and_typing_replays(ds_paper):
    """A large paste step racing a small typing step at the same
    version is the worst case for the unlocked path: positions in the
    typing step were validated against a doc that didn't yet have the
    paste's content. The lock makes the second writer rebase on the
    new version via 409+retry; this test asserts the replay is clean.
    """
    inst, doc_id = await _make_instance(ds_paper)
    _ds, db = ds_paper

    # First, seed with a paragraph containing 10 chars so positions
    # 1..10 are valid.
    for _ in range(10):
        await inst.add_events(
            version=inst.version,
            client_id=99,
            actor_id=None,
            steps=[insert_at(1, "x")],
        )

    paste_text = "PASTED_LONG_BLOCK_OF_TEXT_" * 5

    async def paste():
        while True:
            try:
                await inst.add_events(
                    version=inst.version,
                    client_id=1,
                    actor_id=None,
                    steps=[insert_at(1, paste_text)],
                )
                return
            except ConflictError:
                await asyncio.sleep(0)

    async def type_one():
        while True:
            try:
                await inst.add_events(
                    version=inst.version,
                    client_id=2,
                    actor_id=None,
                    steps=[insert_at(1, "T")],
                )
                return
            except ConflictError:
                await asyncio.sleep(0)

    await asyncio.gather(paste(), type_one())

    inst.materialize_live_doc()
    assert inst._materialization_error is None

    # Rehydrate must match.
    get_registry(_ds)._instances.pop(doc_id, None)
    fresh = await Instance.hydrate(db, doc_id)
    fresh.materialize_live_doc()
    assert fresh._materialization_error is None

    text = _materialize_text(fresh)
    assert paste_text in text
    assert "T" in text


# ---------------------------------------------------------------------------
# SSE subscribe/backlog race
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_subscribe_with_backlog_loses_no_events(ds_paper):
    """``subscribe_with_backlog`` must be atomic w.r.t. ``add_events``.

    We schedule an ``add_events`` to fire in parallel with a
    ``subscribe_with_backlog`` call. Either:
      - the subscribe wins the lock first → backlog returns up to the
        pre-write version, then the broadcast arrives on the queue, OR
      - the add_events wins the lock first → backlog returns including
        the new step, queue stays empty (the broadcast went out before
        we subscribed).

    In NEITHER case may the new step go missing from both backlog AND
    queue. Before this lock, the get_events → subscribe sequence had a
    window where exactly that loss could happen.
    """
    inst, _ = await _make_instance(ds_paper)

    # Seed one step so backlog isn't trivially empty.
    await inst.add_events(
        version=0, client_id=1, actor_id=None, steps=[insert_at(1, "X")]
    )

    # Now race a fresh add_events against a subscribe-with-backlog from
    # version=1. After the race, exactly one of {backlog contains v=2,
    # queue contains v=2 broadcast} must be true.
    async def writer():
        try:
            await inst.add_events(
                version=1, client_id=2, actor_id=None, steps=[insert_at(1, "Y")]
            )
        except ConflictError:
            pass

    async def subscriber():
        return await inst.subscribe_with_backlog(since_version=1, client_id=99)

    # Start both, await both. Order of completion is racey.
    write_task = asyncio.create_task(writer())
    sub_task = asyncio.create_task(subscriber())
    await asyncio.gather(write_task, sub_task)
    queue, backlog = sub_task.result()

    backlog_versions: list[int] = []
    if backlog is not None:
        # The backlog payload steps don't carry a version each; the
        # envelope's `version` is the latest one. The number of steps
        # tells us which versions are included.
        n = len(backlog["steps"])
        latest = backlog["version"]
        backlog_versions = list(range(latest - n + 1, latest + 1))

    # Drain the queue.
    queue_payloads = []
    while not queue.empty():
        queue_payloads.append(queue.get_nowait())

    seen_v2 = 2 in backlog_versions
    for p in queue_payloads:
        if p.get("kind") == "update" and p.get("version") == 2:
            seen_v2 = True
            break

    assert seen_v2, (
        f"Step v=2 was lost in the subscribe/backlog race. "
        f"backlog_versions={backlog_versions} queue={queue_payloads}"
    )


# ---------------------------------------------------------------------------
# Fuzz: N clients typing random valid steps with retries
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fuzz_n_clients_converge(ds_paper):
    """N clients, each does M position-stable inserts with retries on
    409. After all finish, the doc must materialize cleanly, contain
    every client's text, and rehydrate to the same state.

    Deterministic with a seeded RNG so failures are reproducible.
    """
    rng = random.Random(0xC0FFEE)
    inst, doc_id = await _make_instance(ds_paper)
    _ds, db = ds_paper

    N_CLIENTS = 5
    N_EDITS = 10

    async def client(client_id: int, marker: str):
        for _ in range(N_EDITS):
            # Random small back-off to scramble interleavings each run
            # — still deterministic because rng is seeded.
            await asyncio.sleep(rng.random() * 0.002)
            while True:
                try:
                    await inst.add_events(
                        version=inst.version,
                        client_id=client_id,
                        actor_id=None,
                        steps=[insert_at(1, marker)],
                    )
                    break
                except ConflictError:
                    await asyncio.sleep(0)

    await asyncio.gather(*(client(i + 1, chr(ord("a") + i)) for i in range(N_CLIENTS)))

    # Every step landed exactly once → tail size matches total inserts.
    expected_total = N_CLIENTS * N_EDITS
    assert inst.version == expected_total

    # No version duplicates.
    versions = [r["version"] for r in inst.steps_tail]
    assert versions == sorted(set(versions))

    # Live materializes.
    live = inst.materialize_live_doc()
    assert inst._materialization_error is None

    # Rehydrate matches.
    get_registry(_ds)._instances.pop(doc_id, None)
    fresh = await Instance.hydrate(db, doc_id)
    assert fresh.materialize_live_doc() == live
    assert fresh._materialization_error is None

    # Every marker appears.
    text = _materialize_text(fresh)
    for i in range(N_CLIENTS):
        assert chr(ord("a") + i) in text, f"client {i} contribution missing"


# ---------------------------------------------------------------------------
# Edge: add_events while subscribers exist, no other writer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_subscribe_with_backlog_returns_none_when_caught_up(ds_paper):
    """If the caller is already at instance.version, backlog is None
    and the queue is registered. A subsequent add_events broadcasts to
    the queue without filtering (caller's clientID differs).
    """
    inst, _ = await _make_instance(ds_paper)
    await inst.add_events(
        version=0, client_id=1, actor_id=None, steps=[insert_at(1, "X")]
    )

    queue, backlog = await inst.subscribe_with_backlog(
        since_version=inst.version, client_id=99
    )
    assert backlog is None

    # New write — queue should pick it up.
    await inst.add_events(
        version=inst.version, client_id=1, actor_id=None, steps=[insert_at(1, "Y")]
    )
    payload = await asyncio.wait_for(queue.get(), timeout=1.0)
    assert payload["kind"] == "update"
    assert payload["version"] == 2


@pytest.mark.asyncio
async def test_subscribe_with_backlog_410_when_history_evicted(ds_paper):
    """If the caller's since_version is older than what's in
    steps_tail, surface GoneError just like get_events does — the SSE
    route maps this to a 410.
    """
    import collections

    from datasette_paper.errors import GoneError

    inst, _ = await _make_instance(ds_paper)
    # Shrink the tail so eviction fires after 2 writes.
    inst.steps_tail = collections.deque(maxlen=2)
    for i in range(5):
        await inst.add_events(
            version=i, client_id=1, actor_id=None, steps=[insert_at(1, "x")]
        )

    # Caller is way behind — version 0 is no longer in the tail.
    with pytest.raises(GoneError):
        await inst.subscribe_with_backlog(since_version=0, client_id=99)


# ---------------------------------------------------------------------------
# Sanity: existing add_events behavior preserved under the lock
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lock_does_not_deadlock_with_nested_select(ds_paper):
    """Smoke test: a single add_events under the lock still completes.
    Guards against an accidental nested ``async with self._write_lock``
    being introduced elsewhere on the hot path.
    """
    inst, _ = await _make_instance(ds_paper)
    new_version = await inst.add_events(
        version=0, client_id=1, actor_id=None, steps=[insert_at(1, "Z")]
    )
    assert new_version == 1
    text = _materialize_text(inst)
    assert "Z" in text


@pytest.mark.asyncio
async def test_lock_releases_on_validation_failure(ds_paper):
    """If a batch fails validation (InvalidStepError raised inside the
    lock), the lock must release so subsequent calls can proceed.
    """
    from datasette_paper.errors import InvalidStepError

    inst, _ = await _make_instance(ds_paper)

    # First step: a bad step at the doc level. Should raise.
    bad = json.dumps(
        {
            "stepType": "replace",
            "from": 0,
            "to": 0,
            "slice": {"content": [{"type": "text", "text": "x"}]},
        }
    )
    with pytest.raises(InvalidStepError):
        await inst.add_events(version=0, client_id=1, actor_id=None, steps=[bad])

    # Now a valid step must succeed — proves the lock was released.
    new_version = await inst.add_events(
        version=0, client_id=1, actor_id=None, steps=[insert_at(1, "ok")]
    )
    assert new_version == 1
