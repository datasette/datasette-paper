"""Registry ⇄ reality conformance for paper's telemetry.

Static half: the registry is well-formed. Dynamic half: one broad workload
(``exercise``), a single ``collect()``, then the kit's four conformance
assertions plus the sentinel-secret privacy walk.
"""

import pytest

from datasette_paper.telemetry_registry import (
    ATTRIBUTES,
    METRICS,
    SPANS,
)


# --- Static half (no SDK needed) -----------------------------------------


def test_registry_has_no_duplicate_names():
    for group in (SPANS, METRICS, ATTRIBUTES):
        names = [str(entry) for entry in group]
        assert len(names) == len(set(names)), f"duplicates in {names}"


def test_registry_entries_are_documented():
    for entry in (*SPANS, *METRICS, *ATTRIBUTES):
        assert entry.description and entry.description.strip(), (
            f"{entry!r} has no description"
        )


def test_every_histogram_declares_buckets():
    for metric in METRICS:
        if metric.kind == "Histogram":
            assert metric.buckets, f"{metric!r} declares no buckets"
        else:
            assert metric.buckets is None, f"{metric!r} is not a histogram"


def test_entries_are_usable_as_plain_strings():
    for entry in (*SPANS, *METRICS, *ATTRIBUTES):
        assert isinstance(entry, str)
        assert entry == str(entry)


def test_every_paper_name_is_prefixed():
    # The kit docs' naming rule: signals live under a prefix the plugin
    # owns, never bare datasette.*. error.type is core's semconv spelling,
    # deliberately reused.
    for entry in (*SPANS, *METRICS):
        assert str(entry).startswith("paper."), entry
    for attribute in ATTRIBUTES:
        assert str(attribute).startswith("paper.") or str(attribute) == "error.type", (
            attribute
        )


# --- Dynamic half ---------------------------------------------------------

pytest.importorskip("opentelemetry.sdk")

from datasette.telemetry_testing import (  # noqa: E402
    assert_metrics_conform,
    assert_metrics_covered,
    assert_no_forbidden_values,
    assert_spans_conform,
    assert_spans_covered,
)

from conftest import create_doc, setup_paper_datasette  # noqa: E402

# Sentinel secrets planted in the workload. If any of these substrings
# shows up in ANY span name, attribute, event, status description or
# metric attribute — core's scope included — the privacy walk fails.
SENTINEL_DOC_NAME = "SENTINEL-doc-name-7f3a"
SENTINEL_TEXT = "SENTINEL-step-text-9b1c"
SENTINEL_ACTOR = "sentinel-actor-5d2e"
FORBIDDEN = {SENTINEL_DOC_NAME, SENTINEL_TEXT, SENTINEL_ACTOR}


async def exercise(monkeypatch):
    """One broad workload that touches every registered span and metric.

    Returns the Datasette so the caller can hold it alive through the
    metric ``collect()`` — the gauge callbacks read the instance registry
    through a weak set, and a garbage-collected registry reports nothing.
    """
    import asyncio
    import json as _json

    import datasette_paper.sse as sse_module
    from _steps import insert_at
    from conftest import plant_snapshot
    from datasette_paper import instance as instance_mod
    from datasette_paper.instance import get_registry
    from datasette_paper.util import paper_db
    from test_sse_events import SSEStream, _sse_get

    monkeypatch.setattr(sse_module, "HEARTBEAT_SECONDS", 0.05)
    ds, paper = await setup_paper_datasette(actor=SENTINEL_ACTOR)
    registry = get_registry(ds)

    # Create-from-markdown (parse span on the create route), then the
    # main doc for the write pipeline. Names and bodies carry sentinels.
    await ds.client.post(
        "/-/paper/api/docs",
        json={"name": SENTINEL_DOC_NAME, "content": f"# {SENTINEL_TEXT}\n"},
    )
    doc_id = await create_doc(ds, SENTINEL_DOC_NAME, actor_id=SENTINEL_ACTOR)

    def step(pos, text=SENTINEL_TEXT):
        return {
            "stepType": "replace",
            "from": pos,
            "to": pos,
            "slice": {"content": [{"type": "text", "text": text}]},
        }

    events_url = f"/-/paper/api/docs/{doc_id}/events"
    # Accepted write with the auto-snapshot threshold at 1: submit /
    # lock-wait / validate / broadcast / reindex x3 / snapshot(auto).
    monkeypatch.setattr(instance_mod, "SNAPSHOT_THRESHOLD", 1)
    resp = await ds.client.post(
        events_url, json={"version": 0, "clientID": 7, "steps": [step(1)]}
    )
    assert resp.status_code == 200, resp.text
    # Protocol outcomes: a stale version (conflict) and a malformed step
    # (invalid_step).
    monkeypatch.setattr(instance_mod, "SNAPSHOT_THRESHOLD", 100)
    assert (
        await ds.client.post(
            events_url, json={"version": 0, "clientID": 7, "steps": [step(1)]}
        )
    ).status_code == 409
    assert (
        await ds.client.post(
            events_url,
            json={
                "version": 1,
                "clientID": 7,
                "steps": [{"stepType": "replace", "from": 999, "to": 999}],
            },
        )
    ).status_code == 422

    # Markdown append (origin=api, parse span) and an agent-origin
    # markdown edit (serialize + parse spans inside the write lock).
    assert (
        await ds.client.post(
            f"/-/paper/api/docs/{doc_id}/append",
            json={"content": f"appended {SENTINEL_TEXT}"},
        )
    ).status_code == 200
    instance = await registry.get(paper_db(ds), doc_id)
    await instance.apply_markdown_edit(
        lambda md: md + "\n\nagent edit\n", actor_id=SENTINEL_ACTOR, origin="agent"
    )

    # /document — the request-path markdown serialize span.
    assert (
        await ds.client.get(f"/-/paper/api/docs/{doc_id}/document")
    ).status_code == 200

    # Client-triggered snapshot (drift of several steps, threshold 1).
    monkeypatch.setattr(instance_mod, "SNAPSHOT_THRESHOLD", 1)
    assert (
        await ds.client.post(f"/-/paper/api/docs/{doc_id}/snapshot")
    ).status_code == 200
    monkeypatch.setattr(instance_mod, "SNAPSHOT_THRESHOLD", 100)

    # SSE: one stream opened and client-disconnected (open-streams gauge,
    # closed counter, lifetime histogram, request-span enrichment)...
    stream = await _sse_get(
        ds,
        f"/-/paper/api/docs/{doc_id}/events?version={instance.version}",
        actor_id=SENTINEL_ACTOR,
    )
    assert stream.status == 200
    stream.disconnect()
    await asyncio.wait_for(stream._task, 5)
    # ...one subscribe at evicted history (410 → backlog.gone)...
    gone_id = await create_doc(ds, SENTINEL_DOC_NAME, actor_id=SENTINEL_ACTOR)
    await plant_snapshot(
        ds,
        gone_id,
        {"type": "doc", "content": [{"type": "paragraph"}]},
        version=5,
        replace=True,
    )
    signed = ds.sign({"a": {"id": SENTINEL_ACTOR}}, "actor")
    gone_stream = SSEStream(
        ds.app(),
        f"/-/paper/api/docs/{gone_id}/events?version=1",
        cookie_header=f"ds_actor={signed}".encode(),
    )
    await asyncio.wait_for(gone_stream.run(), 5)
    assert gone_stream.status == 410
    # ...and the same stale subscribe from a browser editor (clientID →
    # in-band reset event, backlog.gone{gone_response=reset}).
    reset_stream = SSEStream(
        ds.app(),
        f"/-/paper/api/docs/{gone_id}/events?version=1&clientID=7",
        cookie_header=f"ds_actor={signed}".encode(),
    )
    await asyncio.wait_for(reset_stream.run(), 5)
    assert reset_stream.status == 200

    # Poisoned history: a planted step that cannot apply, so
    # paper.poisoned=True is actually observed (the case that matters).
    bad_doc = await paper.insert_doc(name=SENTINEL_DOC_NAME)
    await paper.insert_step(
        doc_id=bad_doc.id,
        client_id=1,
        actor_id=SENTINEL_ACTOR,
        step_json=_json.dumps(step(0, "x")),
    )
    poisoned_instance = await registry.get(paper, bad_doc.id)
    poisoned_instance.materialize_live_doc()

    # A forced reindex failure (span ERROR + paper.reindex.failures) on a
    # dedicated doc so the main doc's indexes stay healthy.
    fail_id = await create_doc(ds, SENTINEL_DOC_NAME, actor_id=SENTINEL_ACTOR)
    fail_instance = await registry.get(paper_db(ds), fail_id)

    async def explode(**kwargs):
        raise RuntimeError("index unavailable")

    fail_instance.db.replace_inline_tags = explode
    assert (
        await ds.client.post(
            f"/-/paper/api/docs/{fail_id}/events",
            json={"version": 0, "clientID": 7, "steps": [insert_at(1)]},
        )
    ).status_code == 200

    # LRU eviction churn.
    monkeypatch.setattr(instance_mod, "MAX_INSTANCES", 2)
    for name in ("evict-a", "evict-b", "evict-c"):
        extra_id = await create_doc(ds, name, actor_id=SENTINEL_ACTOR)
        await registry.get(paper_db(ds), extra_id)

    # Presence, so the presence gauge reads something real.
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/presence",
        json={"clientID": 7, "anchor": 0, "head": 0},
    )
    return ds


@pytest.mark.asyncio
async def test_conformance(otel_spans, otel_metrics, monkeypatch):
    # @feat telemetry: the registry <-> reality contract, both directions,
    # plus the sentinel-secret privacy walk.
    ds = await exercise(monkeypatch)
    finished = otel_spans.get_finished_spans()
    # One collect() only: the reader is delta-temporality, so anything an
    # earlier collect() drained is invisible to the coverage assertions.
    # `ds` is still alive here, so the gauge callbacks see its registry.
    otel_metrics.collect()
    assert_spans_conform(SPANS, finished, scope_name="datasette_paper")
    assert_spans_covered(SPANS, finished, scope_name="datasette_paper")
    assert_metrics_conform(METRICS, otel_metrics, scope_name="datasette_paper")
    assert_metrics_covered(METRICS, otel_metrics, scope_name="datasette_paper")
    # All scopes for the privacy walk — a sentinel leaking through core's
    # signals (SQL text carrying doc content, say) is still a leak.
    assert_no_forbidden_values(
        FORBIDDEN, finished_spans=finished, collector=otel_metrics
    )
    del ds


# --- Wire names pinned as literals ----------------------------------------
#
# A rename is a dashboard-breaking decision to take here, deliberately,
# not a line to re-derive (the Datasette rationale in its own
# test_telemetry_registry.py). If one of these fails, either revert the
# rename or update the literal AND docs/TELEMETRY.md in the same commit.

EXPECTED_SPANS = {
    "paper.events.submit",
    "paper.write_lock.wait",
    "paper.validate_steps",
    "paper.broadcast",
    "paper.reindex",
    "paper.snapshot",
    "paper.materialize",
    "paper.instance.hydrate",
    "paper.markdown.parse",
    "paper.markdown.serialize",
}

EXPECTED_METRICS = {
    "paper.sse.streams.open",
    "paper.instances.live",
    "paper.steps_tail.max",
    "paper.instances.poisoned",
    "paper.presence.clients",
    "paper.events.submitted",
    "paper.instances.hydrated",
    "paper.instances.evicted",
    "paper.sse.streams.closed",
    "paper.sse.backlog.gone",
    "paper.reindex.failures",
    "paper.snapshots.written",
    "paper.events.duration",
    "paper.write_lock.wait",
    "paper.materialize.duration",
    "paper.hydrate.duration",
    "paper.db.query.duration",
    "paper.broadcast.fanout",
    "paper.events.batch_bytes",
    "paper.sse.stream.duration",
}

EXPECTED_ATTRIBUTES = {
    "paper.doc_id",
    "paper.query_name",
    "paper.operation",
    "paper.origin",
    "paper.outcome",
    "paper.step_count",
    "paper.batch_bytes",
    "paper.subscribers",
    "paper.index",
    "paper.trigger",
    "paper.cache_hit",
    "paper.steps_applied",
    "paper.poisoned",
    "paper.tail_length",
    "paper.snapshot_version",
    "paper.snapshot_bytes",
    "paper.doc_bytes",
    "paper.markdown_bytes",
    "paper.tail_trimmed",
    "paper.close_reason",
    "paper.gone_response",
    "error.type",
}


def test_wire_names_are_pinned():
    assert {str(s) for s in SPANS} == EXPECTED_SPANS
    assert {str(m) for m in METRICS} == EXPECTED_METRICS
    assert {str(a) for a in ATTRIBUTES} == EXPECTED_ATTRIBUTES


def test_generated_docs_are_fresh():
    """docs/TELEMETRY.md matches the registry — the pytest twin of the
    `just check-telemetry-docs-fresh` gate, for anyone running only pytest."""
    import pathlib
    import sys

    root = pathlib.Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(root / "tools"))
    try:
        import telemetry_doc
    finally:
        sys.path.pop(0)
    checked_in = (root / "docs" / "TELEMETRY.md").read_text()
    assert checked_in == telemetry_doc.render(), (
        "docs/TELEMETRY.md is stale — run `just telemetry-docs`"
    )
