"""Span behaviour for paper's OpenTelemetry instrumentation.

Skips as a module when the OpenTelemetry SDK is not installed (it is a
dev-group dependency only). The one exception is the subprocess test,
which needs no provider — but it needs the SDK absent from the *package's*
import graph, which is exactly what it proves.
"""

import asyncio
import importlib.metadata
import sqlite3

import pytest
from opentelemetry.trace import SpanKind, StatusCode

from _steps import insert_at

pytest.importorskip("opentelemetry.sdk")

from datasette.telemetry_testing import (  # noqa: E402
    assert_no_forbidden_values,
    assert_package_never_imports_sdk,
)

from conftest import create_doc  # noqa: E402
from datasette_paper import telemetry  # noqa: E402


def _spans_named(exporter, name, scope=None):
    return [
        span
        for span in exporter.get_finished_spans()
        if span.name == name
        and (
            scope is None
            or (span.instrumentation_scope and span.instrumentation_scope.name == scope)
        )
    ]


def _children_of(finished, parent):
    return sorted(
        (
            span
            for span in finished
            if span.parent is not None and span.parent.span_id == parent.context.span_id
        ),
        key=lambda span: span.start_time,
    )


async def _post_step(ds, doc_id, version=0, client_id=42, steps=None):
    return await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/events",
        json={
            "version": version,
            "clientID": client_id,
            "steps": [insert_at(1)] if steps is None else steps,
        },
    )


def test_package_never_imports_the_sdk():
    # @feat telemetry: the enforcement of "opentelemetry-api only" — the
    # package is imported in a fresh interpreter and nothing under
    # opentelemetry.sdk may land in sys.modules. Front-loaded by name in
    # conftest.py (macOS fork+exec hazard, see the kit docstring).
    assert_package_never_imports_sdk("datasette_paper")


def test_instrumentation_scope_is_datasette_paper_with_version(otel_spans):
    with telemetry.tracer.start_as_current_span("paper.materialize"):
        pass
    (span,) = otel_spans.get_finished_spans()
    assert span.instrumentation_scope.name == "datasette_paper"
    assert span.instrumentation_scope.version == importlib.metadata.version(
        "datasette-paper"
    )


# --- Ticket 02: named callables + no paper.db.query span ------------------


@pytest.mark.asyncio
async def test_read_helper_names_core_callback_span(ds_with_doc, otel_spans):
    ds, paper, doc_id = ds_with_doc
    otel_spans.clear()
    await paper.select_doc_by_id(doc_id)
    # Paper never opens its own db-query span — the trace is core's.
    assert not [
        s
        for s in otel_spans.get_finished_spans()
        if s.instrumentation_scope and s.instrumentation_scope.name == "datasette_paper"
    ]
    db_query = _spans_named(otel_spans, "db.query", scope="datasette")
    if not db_query:
        pytest.skip("installed Datasette does not emit db.query spans")
    (span,) = db_query
    assert span.kind == SpanKind.CLIENT
    assert span.attributes["datasette.callback"] == "select_doc_by_id"


@pytest.mark.asyncio
async def test_write_helper_names_core_callback_span(ds_with_doc, otel_spans):
    ds, paper, doc_id = ds_with_doc
    otel_spans.clear()
    await paper.set_doc_tags(doc_id=doc_id, tags=["alpha"])
    finished = otel_spans.get_finished_spans()
    db_query = [
        s
        for s in finished
        if s.name == "db.query"
        and s.attributes.get("datasette.callback") == "set_doc_tags"
    ]
    if not db_query:
        pytest.skip("installed Datasette does not emit db.query spans")
    (span,) = db_query
    write_execute = [s for s in finished if s.name == "db.write.execute"]
    if write_execute:
        assert any(
            s.parent is not None and s.parent.span_id == span.context.span_id
            for s in write_execute
        )


@pytest.mark.asyncio
async def test_failed_query_records_error_type(ds_paper, otel_metrics):
    _ds, paper = ds_paper

    def explode(conn):
        raise sqlite3.OperationalError("no such table: nope")

    with pytest.raises(sqlite3.OperationalError):
        await paper._read(explode)
    otel_metrics.collect()
    point = otel_metrics.point(
        "paper.db.query.duration",
        {
            "paper.query_name": "explode",
            "paper.operation": "read",
            "error.type": "OperationalError",
        },
    )
    assert point.count == 1


@pytest.mark.asyncio
async def test_no_span_attribute_contains_sql_or_doc_content(
    ds_paper, otel_spans, otel_metrics
):
    ds, _paper = ds_paper
    sentinel_name = "SENTINEL-title-3c9d"
    sentinel_text = "SENTINEL-body-1e7f"
    doc_id = await create_doc(ds, sentinel_name)
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/events",
        json={
            "version": 0,
            "clientID": 7,
            "steps": [
                {
                    "stepType": "replace",
                    "from": 1,
                    "to": 1,
                    "slice": {"content": [{"type": "text", "text": sentinel_text}]},
                }
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    otel_metrics.collect()
    finished = otel_spans.get_finished_spans()
    # The kit walks span names, attributes, events, status descriptions and
    # metric attributes. Doc content and titles must not appear in ANY
    # scope — core's included (SQL text never carries parameter values).
    assert_no_forbidden_values(
        {sentinel_name, sentinel_text},
        finished_spans=finished,
        collector=otel_metrics,
    )
    # And no raw SQL leaks into paper's own scope (core legitimately
    # records truncated SQL text on its SQL-string spans, so this half is
    # scoped to datasette_paper).
    assert_no_forbidden_values(
        {"SELECT", "INSERT", "select ", "insert "},
        finished_spans=finished,
        collector=otel_metrics,
        scope_name="datasette_paper",
    )


# --- Ticket 03: the submit pipeline ---------------------------------------


@pytest.mark.asyncio
async def test_submit_span_ok_shape(ds_with_doc, otel_spans):
    # @feat telemetry: the canonical write-pipeline trace shape.
    ds, _paper, doc_id = ds_with_doc
    otel_spans.clear()
    resp = await _post_step(ds, doc_id)
    assert resp.status_code == 200
    (submit,) = _spans_named(otel_spans, "paper.events.submit")
    assert submit.attributes["paper.outcome"] == "ok"
    assert submit.attributes["paper.origin"] == "collab"
    assert submit.attributes["paper.step_count"] == 1
    assert submit.attributes["paper.doc_id"] == doc_id
    assert submit.attributes["paper.batch_bytes"] > 0
    assert "paper.subscribers" in submit.attributes
    finished = otel_spans.get_finished_spans()
    children = _children_of(finished, submit)
    paper_names = [span.name for span in children if span.name.startswith("paper.")]
    # write_lock.wait, then validate, then the broadcast — in start order.
    # (reindex spans, ticket 06, come after the broadcast.)
    assert paper_names[:2] == ["paper.write_lock.wait", "paper.validate_steps"]
    assert "paper.broadcast" in paper_names
    db_children = [span for span in children if span.name == "db.query"]
    if db_children:
        # Core's span for the step write, named after ticket 02, starting
        # between validate and broadcast.
        (insert_span,) = [
            span
            for span in db_children
            if span.attributes.get("datasette.callback") == "insert_steps"
        ]
        (validate,) = [s for s in children if s.name == "paper.validate_steps"]
        (broadcast,) = [s for s in children if s.name == "paper.broadcast"]
        assert validate.start_time <= insert_span.start_time <= broadcast.start_time


@pytest.mark.asyncio
async def test_submit_conflict_is_an_outcome_not_an_error(ds_with_doc, otel_spans):
    ds, _paper, doc_id = ds_with_doc
    assert (await _post_step(ds, doc_id)).status_code == 200
    otel_spans.clear()
    resp = await _post_step(ds, doc_id, version=0)  # stale — server is at 1
    assert resp.status_code == 409
    (submit,) = _spans_named(otel_spans, "paper.events.submit")
    assert submit.attributes["paper.outcome"] == "conflict"
    assert submit.status.status_code == StatusCode.UNSET


@pytest.mark.asyncio
async def test_submit_invalid_step_outcome(ds_with_doc, otel_spans):
    ds, _paper, doc_id = ds_with_doc
    otel_spans.clear()
    resp = await _post_step(
        ds, doc_id, steps=[{"stepType": "replace", "from": 99, "to": 99}]
    )
    assert resp.status_code == 422
    (submit,) = _spans_named(otel_spans, "paper.events.submit")
    assert submit.attributes["paper.outcome"] == "invalid_step"
    assert submit.status.status_code == StatusCode.UNSET
    finished = otel_spans.get_finished_spans()
    # Rejected before any write: no db.query child under the submit span.
    assert not [
        span for span in _children_of(finished, submit) if span.name == "db.query"
    ]


@pytest.mark.asyncio
async def test_submit_origin_api_and_agent(ds_with_doc, otel_spans):
    ds, _paper, doc_id = ds_with_doc
    otel_spans.clear()
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append",
        json={"content": "hello from the api"},
    )
    assert resp.status_code == 200, resp.text
    (submit,) = _spans_named(otel_spans, "paper.events.submit")
    assert submit.attributes["paper.origin"] == "api"

    from datasette_paper.instance import get_registry
    from datasette_paper.util import paper_db

    otel_spans.clear()
    registry = get_registry(ds)
    instance = await registry.get(paper_db(ds), doc_id)
    await instance.apply_markdown_edit(
        lambda md: md + "\n\nagent was here\n", actor_id="alice", origin="agent"
    )
    (submit,) = _spans_named(otel_spans, "paper.events.submit")
    assert submit.attributes["paper.origin"] == "agent"
    assert submit.attributes["paper.outcome"] == "ok"


@pytest.mark.asyncio
async def test_write_lock_wait_span_has_explicit_duration(ds_with_doc, otel_spans):
    ds, _paper, doc_id = ds_with_doc
    from datasette_paper.instance import get_registry
    from datasette_paper.util import paper_db

    registry = get_registry(ds)
    instance = await registry.get(paper_db(ds), doc_id)
    otel_spans.clear()
    await instance._write_lock.acquire()
    post = asyncio.ensure_future(_post_step(ds, doc_id))
    # The request needs a few ms to travel the ASGI stack before it blocks
    # on the lock, so hold it comfortably longer than the asserted bound.
    await asyncio.sleep(0.1)
    instance._write_lock.release()
    resp = await post
    assert resp.status_code == 200
    waits = _spans_named(otel_spans, "paper.write_lock.wait")
    assert any(span.end_time - span.start_time >= 50_000_000 for span in waits)
    for span in waits:
        assert span.attributes["paper.doc_id"] == doc_id


# --- Ticket 04: materialize + hydrate spans -------------------------------


_BAD_STEP = {
    "stepType": "replace",
    "from": 0,
    "to": 0,
    "slice": {"content": [{"type": "text", "text": "x"}]},
}


async def _poisoned_instance(paper, name="Poisoned"):
    """A hydrated Instance whose one-step history fails to apply."""
    import json as _json

    from datasette_paper.instance import Instance

    doc = await paper.insert_doc(name=name)
    await paper.insert_step(
        doc_id=doc.id, client_id=1, actor_id=None, step_json=_json.dumps(_BAD_STEP)
    )
    return await Instance.hydrate(paper, doc.id)


@pytest.mark.asyncio
async def test_materialize_cache_hit_vs_miss(ds_with_doc, otel_spans):
    # @feat telemetry: cache_hit distinguishes a replay from a lookup.
    ds, _paper, doc_id = ds_with_doc
    from datasette_paper.instance import get_registry
    from datasette_paper.util import paper_db

    registry = get_registry(ds)
    instance = await registry.get(paper_db(ds), doc_id)
    assert (await _post_step(ds, doc_id)).status_code == 200
    otel_spans.clear()
    instance._cached_live_doc_json = None  # force a real replay
    instance.materialize_live_doc()
    instance.materialize_live_doc()
    first, second = _spans_named(otel_spans, "paper.materialize")
    assert first.attributes["paper.cache_hit"] is False
    assert first.attributes["paper.steps_applied"] == 1
    assert second.attributes["paper.cache_hit"] is True
    assert second.attributes["paper.steps_applied"] == 0


@pytest.mark.asyncio
async def test_materialize_poisoned_sets_attribute_not_error(ds_paper, otel_spans):
    _ds, paper = ds_paper
    instance = await _poisoned_instance(paper)
    otel_spans.clear()
    instance.materialize_live_doc()
    (span,) = _spans_named(otel_spans, "paper.materialize")
    assert span.attributes["paper.poisoned"] is True
    assert span.status.status_code == StatusCode.UNSET


@pytest.mark.asyncio
async def test_hydrate_span_reports_tail_length(ds_paper, otel_spans):
    ds, paper = ds_paper
    from conftest import plant_snapshot
    from datasette_paper.instance import get_registry

    doc_id = await create_doc(ds, "Hydrate me")
    await plant_snapshot(
        ds, doc_id, {"type": "doc", "content": [{"type": "paragraph"}]}
    )
    for pos in (1, 2, 3):
        await paper.insert_step(
            doc_id=doc_id, client_id=1, actor_id=None, step_json=insert_at(pos, "x")
        )
    registry = get_registry(ds)
    registry._instances.pop(doc_id, None)
    otel_spans.clear()
    await registry.get(paper, doc_id)
    (span,) = _spans_named(otel_spans, "paper.instance.hydrate")
    assert span.attributes["paper.doc_id"] == doc_id
    assert span.attributes["paper.snapshot_version"] == 0
    assert span.attributes["paper.tail_length"] == 3


@pytest.mark.asyncio
async def test_hydrate_join_adds_event_on_joining_callers_span(ds_paper, otel_spans):
    from datasette_paper.instance import InstanceRegistry

    _ds, paper = ds_paper
    doc = await paper.insert_doc(name="Joined")
    registry = InstanceRegistry()

    async def get_under(name):
        with telemetry.tracer.start_as_current_span(name):
            return await registry.get(paper, doc.id)

    otel_spans.clear()
    await asyncio.gather(get_under("first"), get_under("joiner"))
    (first,) = _spans_named(otel_spans, "first")
    (joiner,) = _spans_named(otel_spans, "joiner")
    assert not [e for e in first.events if e.name == "paper.instance.hydrate.joined"]
    (event,) = [e for e in joiner.events if e.name == "paper.instance.hydrate.joined"]
    assert event.attributes["paper.doc_id"] == doc.id
    # No links, no extra spans: the one hydrate parents under the first.
    (hydrate,) = _spans_named(otel_spans, "paper.instance.hydrate")
    assert hydrate.parent.span_id == first.context.span_id


# --- Ticket 05: SSE — request-span enrichment, never own spans ------------


async def _open_sse(ds, doc_id, version=0, actor="alice"):
    from test_sse_events import _sse_get

    return await _sse_get(
        ds, f"/-/paper/api/docs/{doc_id}/events?version={version}", actor_id=actor
    )


@pytest.mark.asyncio
async def test_sse_enriches_request_span_when_recording(
    ds_with_doc, otel_spans, monkeypatch
):
    import datasette_paper.sse as sse_module

    monkeypatch.setattr(sse_module, "HEARTBEAT_SECONDS", 0.05)
    ds, _paper, doc_id = ds_with_doc
    otel_spans.clear()
    stream = await _open_sse(ds, doc_id)
    assert stream.status == 200
    stream.disconnect()
    await asyncio.wait_for(stream._task, 5)
    server_spans = [
        span
        for span in otel_spans.get_finished_spans()
        if span.kind == SpanKind.SERVER
        and span.attributes.get("paper.doc_id") == doc_id
    ]
    (request,) = server_spans
    assert request.attributes["paper.close_reason"] == "client_disconnect"
    (backlog_event,) = [
        event for event in request.events if event.name == "paper.sse.backlog"
    ]
    assert backlog_event.attributes["paper.step_count"] == 0


@pytest.mark.asyncio
async def test_sse_reset_enriches_request_span(ds_with_doc, otel_spans):
    from conftest import plant_snapshot
    from test_sse_events import SSEStream

    ds, _paper, doc_id = ds_with_doc
    await plant_snapshot(
        ds,
        doc_id,
        {"type": "doc", "content": [{"type": "paragraph"}]},
        version=5,
        replace=True,
    )
    otel_spans.clear()
    signed = ds.sign({"a": {"id": "alice"}}, "actor")
    stream = SSEStream(
        ds.app(),
        f"/-/paper/api/docs/{doc_id}/events?version=1&clientID=7",
        cookie_header=f"ds_actor={signed}".encode(),
    )
    await asyncio.wait_for(stream.run(), 5)
    assert stream.status == 200
    (request,) = [
        span
        for span in otel_spans.get_finished_spans()
        if span.kind == SpanKind.SERVER
        and span.attributes.get("paper.doc_id") == doc_id
    ]
    assert request.attributes["paper.gone_response"] == "reset"


@pytest.mark.asyncio
async def test_sse_route_opens_no_paper_spans(ds_with_doc, otel_spans, monkeypatch):
    # @feat telemetry: pins the design decision — the streaming route gets
    # no spans of its own, ever (the request span would hold them open for
    # the connection lifetime; gauges + span events carry the signal).
    import datasette_paper.sse as sse_module

    monkeypatch.setattr(sse_module, "HEARTBEAT_SECONDS", 0.05)
    ds, _paper, doc_id = ds_with_doc
    otel_spans.clear()
    stream = await _open_sse(ds, doc_id)
    assert stream.status == 200
    stream.disconnect()
    await asyncio.wait_for(stream._task, 5)
    assert not [
        span
        for span in otel_spans.get_finished_spans()
        if span.name.startswith("paper.sse")
    ]


# --- Ticket 06: write tail — reindex, snapshot, markdown ------------------


@pytest.mark.asyncio
async def test_reindex_emits_three_spans_per_write(ds_with_doc, otel_spans):
    # @feat telemetry: three paper.reindex children per accepted write.
    ds, _paper, doc_id = ds_with_doc
    otel_spans.clear()
    assert (await _post_step(ds, doc_id)).status_code == 200
    finished = otel_spans.get_finished_spans()
    (submit,) = _spans_named(otel_spans, "paper.events.submit")
    reindex = [
        span for span in _children_of(finished, submit) if span.name == "paper.reindex"
    ]
    assert {span.attributes["paper.index"] for span in reindex} == {
        "links",
        "tags",
        "tasks",
    }
    for span in reindex:
        assert span.attributes["paper.doc_id"] == doc_id
        assert span.attributes["paper.skipped"] is False


@pytest.mark.asyncio
async def test_reindex_early_returns_are_marked_skipped(ds_with_doc, otel_spans):
    from datasette_paper.instance import get_registry
    from datasette_paper.util import paper_db

    ds, paper, doc_id = ds_with_doc
    assert (await _post_step(ds, doc_id)).status_code == 200
    instance = await get_registry(ds).get(paper_db(ds), doc_id)
    otel_spans.clear()
    await instance.reindex_links()  # already indexed at this version
    (span,) = _spans_named(otel_spans, "paper.reindex")
    assert span.attributes["paper.skipped"] is True

    poisoned = await _poisoned_instance(paper)
    poisoned.materialize_live_doc()
    otel_spans.clear()
    await poisoned.reindex_tags()
    (span,) = _spans_named(otel_spans, "paper.reindex")
    assert span.attributes["paper.skipped"] is True


@pytest.mark.asyncio
async def test_reindex_failure_is_error_span_and_counted(
    ds_with_doc, otel_spans, otel_metrics
):
    from datasette_paper.instance import get_registry
    from datasette_paper.util import paper_db

    ds, _paper, doc_id = ds_with_doc
    registry = get_registry(ds)
    instance = await registry.get(paper_db(ds), doc_id)

    async def explode(**kwargs):
        raise RuntimeError("tag index unavailable")

    instance.db.replace_inline_tags = explode
    otel_spans.clear()
    otel_metrics.reader.get_metrics_data()
    # The write still succeeds — a derived-index failure must not fail
    # the user's edit (existing contract).
    assert (await _post_step(ds, doc_id)).status_code == 200
    (tags_span,) = [
        span
        for span in _spans_named(otel_spans, "paper.reindex")
        if span.attributes["paper.index"] == "tags"
    ]
    assert tags_span.status.status_code == StatusCode.ERROR
    (event,) = [event for event in tags_span.events if event.name == "exception"]
    assert dict(event.attributes) == {"exception.type": "RuntimeError"}
    otel_metrics.collect()
    point = otel_metrics.point("paper.reindex.failures", {"paper.index": "tags"})
    assert point.value == 1


@pytest.mark.asyncio
async def test_reindex_failure_message_is_not_recorded(ds_with_doc, otel_spans):
    # @feat telemetry: a reindex exception's message can echo doc content;
    # only its class name may reach a span.
    from datasette_paper.instance import get_registry
    from datasette_paper.util import paper_db

    ds, _paper, doc_id = ds_with_doc
    instance = await get_registry(ds).get(paper_db(ds), doc_id)
    sentinel = "SENTINEL-tag-slug-4a8e"

    async def explode(**kwargs):
        raise RuntimeError(f"bad tag {sentinel}")

    instance.db.replace_inline_tags = explode
    otel_spans.clear()
    assert (await _post_step(ds, doc_id)).status_code == 200
    finished = otel_spans.get_finished_spans()
    assert any(span.status.status_code == StatusCode.ERROR for span in finished)
    assert_no_forbidden_values({sentinel}, finished_spans=finished)


@pytest.mark.asyncio
async def test_snapshot_span_auto_vs_client(ds_with_doc, otel_spans, monkeypatch):
    from datasette_paper import instance as instance_mod

    monkeypatch.setattr(instance_mod, "SNAPSHOT_THRESHOLD", 1)
    ds, _paper, doc_id = ds_with_doc
    otel_spans.clear()
    assert (await _post_step(ds, doc_id)).status_code == 200
    (auto_span,) = _spans_named(otel_spans, "paper.snapshot")
    assert auto_span.attributes["paper.trigger"] == "auto"
    assert auto_span.attributes["paper.snapshot_bytes"] > 0
    assert auto_span.attributes["paper.tail_trimmed"] >= 1

    # Raise the threshold so the next write does NOT auto-snapshot, then
    # drop it again so the explicit POST /snapshot sees enough drift.
    monkeypatch.setattr(instance_mod, "SNAPSHOT_THRESHOLD", 100)
    assert (await _post_step(ds, doc_id, version=1)).status_code == 200
    monkeypatch.setattr(instance_mod, "SNAPSHOT_THRESHOLD", 1)
    otel_spans.clear()
    resp = await ds.client.post(f"/-/paper/api/docs/{doc_id}/snapshot")
    assert resp.status_code == 200
    (client_span,) = _spans_named(otel_spans, "paper.snapshot")
    assert client_span.attributes["paper.trigger"] == "client"


@pytest.mark.asyncio
async def test_markdown_parse_span_on_append_route(ds_with_doc, otel_spans, tmp_path):
    ds, _paper, doc_id = ds_with_doc
    body = "some **markdown** to append"
    otel_spans.clear()
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/append", json={"content": body}
    )
    assert resp.status_code == 200
    (parse,) = _spans_named(otel_spans, "paper.markdown.parse")
    assert parse.attributes["paper.markdown_bytes"] == len(body)

    # The CLI export path stays span-free: wrap the call site, not the
    # parser/serializer modules.
    from _cli import create_doc_with_content, file_backed_ds, run_cli

    cli_ds, internal = await file_backed_ds(tmp_path)
    cli_doc_id = await create_doc_with_content(cli_ds)
    otel_spans.clear()
    result = run_cli("paper", "export", internal, str(cli_doc_id))
    assert result.exit_code == 0, result.output
    assert not [
        span
        for span in otel_spans.get_finished_spans()
        if span.name.startswith("paper.markdown.")
    ]
