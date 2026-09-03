"""Span behaviour for paper's OpenTelemetry instrumentation.

Skips as a module when the OpenTelemetry SDK is not installed (it is a
dev-group dependency only). The one exception is the subprocess test,
which needs no provider — but it needs the SDK absent from the *package's*
import graph, which is exactly what it proves.
"""

import importlib.metadata
import sqlite3

import pytest
from opentelemetry.trace import SpanKind

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
