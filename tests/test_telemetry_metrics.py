"""Instrument behaviour and gauge callbacks.

The gauge callbacks are plain generator functions, so most tests here call
them directly — no SDK reader needed. The registry-backed weak set is
process-global, so tests that assert on gauge values snapshot against the
observations attributable to their own objects where possible.
"""

import gc

import pytest

pytest.importorskip("opentelemetry.sdk")

from datasette_paper import telemetry  # noqa: E402
from datasette_paper.instance import InstanceRegistry  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_registry_weakset():
    """Isolate the process-global weak set of registries per test.

    Other tests in the suite create Datasette instances whose registries
    land in the weak set; drain it around each test here so gauge
    assertions see only this test's registries.
    """
    with telemetry._live_registries_lock:
        saved = set(telemetry._live_registries)
        telemetry._live_registries.clear()
    yield
    with telemetry._live_registries_lock:
        telemetry._live_registries.clear()
        telemetry._live_registries.update(saved)


def _observations(generator):
    return [observation.value for observation in generator]


def test_gauge_callbacks_yield_nothing_with_no_registry():
    assert _observations(telemetry.observe_live_instances()) == []
    # The summed gauges always yield one observation; with no registries
    # the sum is zero.
    assert _observations(telemetry.observe_open_streams()) == [0]
    assert _observations(telemetry.observe_tail_max()) == [0]
    assert _observations(telemetry.observe_poisoned()) == [0]
    assert _observations(telemetry.observe_presence_clients()) == [0]


@pytest.mark.asyncio
async def test_db_query_duration_records_per_helper(ds_with_doc, otel_metrics):
    _ds, paper, doc_id = ds_with_doc
    # Drain what the fixture's create_doc recorded, then measure two
    # distinct read helpers.
    otel_metrics.reader.get_metrics_data()
    await paper.select_doc_by_id(doc_id)
    await paper.list_docs()
    otel_metrics.collect()
    for name in ("select_doc_by_id", "list_docs"):
        point = otel_metrics.point(
            "paper.db.query.duration",
            {"paper.query_name": name, "paper.operation": "read"},
        )
        assert point.count == 1


def test_register_instance_registry_is_weak():
    registry = InstanceRegistry()
    telemetry.register_instance_registry(registry)
    assert _observations(telemetry.observe_live_instances()) == [0]
    del registry
    gc.collect()
    assert _observations(telemetry.observe_live_instances()) == []


# --- Ticket 03: submit pipeline metrics -----------------------------------


async def _post_step(ds, doc_id, version=0):
    from _steps import insert_at

    return await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/events",
        json={"version": version, "clientID": 42, "steps": [insert_at(1)]},
    )


@pytest.mark.asyncio
async def test_events_submitted_counter_by_outcome(ds_with_doc, otel_metrics):
    ds, _paper, doc_id = ds_with_doc
    otel_metrics.reader.get_metrics_data()  # drain fixture noise
    assert (await _post_step(ds, doc_id)).status_code == 200
    assert (await _post_step(ds, doc_id, version=0)).status_code == 409
    otel_metrics.collect()
    for outcome in ("ok", "conflict"):
        point = otel_metrics.point(
            "paper.events.submitted",
            {"paper.outcome": outcome, "paper.origin": "collab"},
        )
        assert point.value == 1


@pytest.mark.asyncio
async def test_events_duration_histogram_has_one_point_per_outcome(
    ds_with_doc, otel_metrics
):
    ds, _paper, doc_id = ds_with_doc
    otel_metrics.reader.get_metrics_data()
    assert (await _post_step(ds, doc_id)).status_code == 200
    assert (await _post_step(ds, doc_id, version=0)).status_code == 409
    otel_metrics.collect()
    for outcome in ("ok", "conflict"):
        point = otel_metrics.point(
            "paper.events.duration",
            {"paper.outcome": outcome, "paper.origin": "collab"},
        )
        assert point.count == 1


@pytest.mark.asyncio
async def test_write_lock_wait_histogram_records_real_wait(ds_with_doc, otel_metrics):
    import asyncio

    from datasette_paper.instance import get_registry
    from datasette_paper.util import paper_db

    ds, _paper, doc_id = ds_with_doc
    registry = get_registry(ds)
    instance = await registry.get(paper_db(ds), doc_id)
    otel_metrics.reader.get_metrics_data()
    await instance._write_lock.acquire()
    post = asyncio.ensure_future(_post_step(ds, doc_id))
    await asyncio.sleep(0.1)
    instance._write_lock.release()
    assert (await post).status_code == 200
    otel_metrics.collect()
    (point,) = otel_metrics.points("paper.write_lock.wait")
    assert point.sum >= 0.05


# --- Ticket 04: instance gauges + churn counters --------------------------


@pytest.mark.asyncio
async def test_live_instances_gauge(ds_paper):
    from conftest import create_doc
    from datasette_paper.instance import get_registry
    from datasette_paper.util import paper_db

    ds, _paper = ds_paper
    registry = get_registry(ds)
    telemetry.register_instance_registry(registry)  # weakset was drained
    for name in ("one", "two"):
        doc_id = await create_doc(ds, name)
        await registry.get(paper_db(ds), doc_id)
    assert _observations(telemetry.observe_live_instances()) == [2]


@pytest.mark.asyncio
async def test_evicted_counter_after_max_instances(ds_paper, otel_metrics, monkeypatch):
    from conftest import create_doc
    from datasette_paper import instance as instance_mod
    from datasette_paper.instance import get_registry
    from datasette_paper.util import paper_db

    monkeypatch.setattr(instance_mod, "MAX_INSTANCES", 2)
    ds, _paper = ds_paper
    registry = get_registry(ds)
    otel_metrics.reader.get_metrics_data()
    for name in ("a", "b", "c"):
        doc_id = await create_doc(ds, name)
        await registry.get(paper_db(ds), doc_id)
    otel_metrics.collect()
    assert otel_metrics.point("paper.instances.evicted").value == 1
    assert otel_metrics.point("paper.instances.hydrated").value == 3


@pytest.mark.asyncio
async def test_tail_max_gauge_tracks_longest_tail(ds_paper):
    from _steps import insert_at
    from conftest import create_doc
    from datasette_paper.instance import get_registry

    ds, paper = ds_paper
    registry = get_registry(ds)
    telemetry.register_instance_registry(registry)
    long_id = await create_doc(ds, "long")
    short_id = await create_doc(ds, "short")
    for step_count, doc_id in ((5, long_id), (1, short_id)):
        for pos in range(1, step_count + 1):
            await paper.insert_step(
                doc_id=doc_id, client_id=1, actor_id=None, step_json=insert_at(pos, "x")
            )
        registry._instances.pop(doc_id, None)
        await registry.get(paper, doc_id)
    assert _observations(telemetry.observe_tail_max()) == [5]


@pytest.mark.asyncio
async def test_poisoned_gauge_counts_bad_history(ds_paper):
    import json as _json

    from datasette_paper.instance import get_registry

    ds, paper = ds_paper
    registry = get_registry(ds)
    telemetry.register_instance_registry(registry)
    doc = await paper.insert_doc(name="Poisoned")
    await paper.insert_step(
        doc_id=doc.id,
        client_id=1,
        actor_id=None,
        step_json=_json.dumps(
            {
                "stepType": "replace",
                "from": 0,
                "to": 0,
                "slice": {"content": [{"type": "text", "text": "x"}]},
            }
        ),
    )
    instance = await registry.get(paper, doc.id)
    instance.materialize_live_doc()
    assert _observations(telemetry.observe_poisoned()) == [1]
    # Nothing repaired the history — still poisoned on the next look.
    instance.materialize_live_doc()
    assert _observations(telemetry.observe_poisoned()) == [1]


@pytest.mark.asyncio
async def test_materialize_duration_histogram_split_by_cache_hit(
    ds_with_doc, otel_metrics
):
    from datasette_paper.instance import get_registry
    from datasette_paper.util import paper_db

    ds, _paper, doc_id = ds_with_doc
    registry = get_registry(ds)
    instance = await registry.get(paper_db(ds), doc_id)
    otel_metrics.reader.get_metrics_data()
    instance._cached_live_doc_json = None
    instance.materialize_live_doc()
    instance.materialize_live_doc()
    otel_metrics.collect()
    for cache_hit in (False, True):
        point = otel_metrics.point(
            "paper.materialize.duration", {"paper.cache_hit": cache_hit}
        )
        assert point.count == 1
