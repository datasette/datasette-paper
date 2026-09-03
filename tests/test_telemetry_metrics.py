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
