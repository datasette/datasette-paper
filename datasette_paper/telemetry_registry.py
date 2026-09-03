"""The single source of truth for every OpenTelemetry signal paper emits.
@feat telemetry: the registry — every span, attribute and metric, with docs.

Built from Datasette's public plugin telemetry kit
(``datasette.telemetry_registry`` — see Datasette's "Telemetry for plugin
authors" docs): the ``Attribute`` / ``SpanName`` / ``MetricName`` classes
subclass ``str``, so a registry entry *is* the name handed to OpenTelemetry.

Three things read this module:

1. **The instrumentation** in ``telemetry.py`` and the call sites it serves.
2. **The generated reference** ``docs/TELEMETRY.md`` (``just telemetry-docs``).
3. **The conformance test** ``tests/test_telemetry_registry.py``, which runs
   a broad workload and asserts both directions with the kit's helpers:
   everything emitted is registered (enum membership included) and
   everything registered is emitted.

Naming rules (from the kit docs): the instrumentation scope is the import
package name (``datasette_paper``); every span, metric and custom attribute
lives under the ``paper.*`` prefix paper owns — never bare ``datasette.*``.
The one exception is ``error.type``, core's semconv spelling, reused rather
than shadowed by a parallel ``paper.error``.

Privacy: nothing here is a person, a document's content, or a client-chosen
string. Sizes are byte counts, variability is closed enums, and
``paper.doc_id`` rides on spans only — never on a metric.
"""

from datasette.telemetry_registry import (
    COUNTER,
    DURATION_BUCKETS,
    GAUGE,
    HISTOGRAM,
    Attribute,
    MetricName,
    SpanName,
)

__all__ = [
    "ATTRIBUTES",
    "BYTE_BUCKETS",
    "COUNT_BUCKETS",
    "DURATION_BUCKETS",
    "METRICS",
    "SPANS",
    "STREAM_BUCKETS",
]

# --- Histogram bucket boundaries ------------------------------------------
#
# Every duration histogram uses DURATION_BUCKETS imported from Datasette's
# registry, so a paper p95 reads against a core p95 on the same axis by
# construction. The remaining sets exist because the SDK defaults are
# useless for counts, bytes and connection lifetimes.

COUNT_BUCKETS = (1, 2, 5, 10, 20, 50, 100, 200)  # subscriber fan-out
BYTE_BUCKETS = (
    256,
    1024,
    4096,
    16384,
    65536,
    262144,
    1048576,
    4194304,
    12582912,  # MAX_STEP_BYTES
)
STREAM_BUCKETS = (1, 5, 30, 60, 300, 900, 1800, 3600, 14400)  # SSE lifetimes


# --- Attributes -----------------------------------------------------------

DOC_ID = Attribute(
    "paper.doc_id",
    "The document's integer id. Bounded by the instance's doc table, not by "
    "request input. Rides on spans only — **never on a metric**, where a "
    "per-doc dimension would be an unbounded series per document.",
)
QUERY_NAME = Attribute(
    "paper.query_name",
    "The query helper's name (``select_steps_after``, ``insert_step``, …) — "
    "the generated helper's ``__name__``, or the normalized closure name for "
    "the explicit multi-statement writers. A fixed set defined by the code, "
    "so safe as a metric dimension. The same string reaches core's "
    "``db.query`` span as ``datasette.callback``.",
)
OPERATION = Attribute(
    "paper.operation",
    "Whether the timed query helper was a read or a write.",
    values={"read", "write"},
)
ORIGIN = Attribute(
    "paper.origin",
    "Where the write entered: ``collab`` (browser step POST), ``api`` (the "
    "markdown append route), ``agent`` (datasette-agent tools). Passed by "
    "the caller, never inferred.",
    values={"collab", "api", "agent"},
)
OUTCOME = Attribute(
    "paper.outcome",
    "How the submit pipeline ended. ``conflict`` / ``bad_version`` / "
    "``gone`` / ``invalid_step`` are the protocol working, not errors; only "
    "``error`` (an unexpected exception) sets span status ``ERROR``. "
    "Clamped at the call site: anything unrecognised becomes ``error``.",
    values={"ok", "empty", "conflict", "bad_version", "gone", "invalid_step", "error"},
)
STEP_COUNT = Attribute(
    "paper.step_count",
    "Number of steps in the batch (or flushed in an SSE backlog event).",
)
BATCH_BYTES = Attribute(
    "paper.batch_bytes",
    "Sum of the serialized step JSON lengths for the batch. The content "
    "itself is never recorded.",
)
SUBSCRIBERS = Attribute(
    "paper.subscribers",
    "``len(instance.subscribers)`` at broadcast time.",
)
INDEX = Attribute(
    "paper.index",
    "Which derived index a reindex pass rebuilt.",
    values={"links", "tags", "tasks"},
)
TRIGGER = Attribute(
    "paper.trigger",
    "What asked for the snapshot: ``client`` (POST /snapshot) or ``auto`` "
    "(the write-tail threshold check).",
    values={"client", "auto"},
)
CACHE_HIT = Attribute(
    "paper.cache_hit",
    "True when materialize served the cached live doc without replaying any steps.",
)
STEPS_APPLIED = Attribute(
    "paper.steps_applied",
    "Steps replayed over the snapshot on this materialization (0 on a cache hit).",
)
POISONED = Attribute(
    "paper.poisoned",
    "True when a step in history failed to apply and the instance is "
    "carrying a materialization error. The span status stays ``UNSET`` — "
    "``materialize_live_doc`` never raises; the "
    "``paper.instances.poisoned`` gauge is the alert.",
)
TAIL_LENGTH = Attribute(
    "paper.tail_length",
    "Steps loaded into the in-memory tail on hydrate.",
)
SNAPSHOT_VERSION = Attribute(
    "paper.snapshot_version",
    "The version of the snapshot the hydrate started from (0 when the doc has none).",
)
SNAPSHOT_BYTES = Attribute(
    "paper.snapshot_bytes",
    "Length of the snapshot's serialized doc JSON. A size, never the doc.",
)
DOC_BYTES = Attribute(
    "paper.doc_bytes",
    "Length of the JSON doc fed to the markdown serializer. A size, never the doc.",
)
MARKDOWN_BYTES = Attribute(
    "paper.markdown_bytes",
    "Length of the markdown text fed to the parser. A size, never the text.",
)
TAIL_TRIMMED = Attribute(
    "paper.tail_trimmed",
    "Steps dropped from the in-memory tail because the new snapshot baked them in.",
)
CLOSE_REASON = Attribute(
    "paper.close_reason",
    "Why an SSE stream ended: ``client_disconnect`` (the normal case), "
    "``revoked`` (access removed mid-session), ``send_error`` (the socket "
    "write failed), ``cancelled`` (the server task was cancelled). Set on "
    "Datasette's request span and on the SSE close metrics.",
    values={"client_disconnect", "revoked", "send_error", "cancelled"},
)
ERROR_TYPE = Attribute(
    "error.type",
    "The exception class name when a timed query helper failed; absent on "
    "success. Core's semantic-convention spelling, reused per the plugin "
    "telemetry docs — never a parallel ``paper.error``.",
    optional=True,
)


ATTRIBUTES = (
    DOC_ID,
    QUERY_NAME,
    OPERATION,
    ORIGIN,
    OUTCOME,
    STEP_COUNT,
    BATCH_BYTES,
    SUBSCRIBERS,
    INDEX,
    TRIGGER,
    CACHE_HIT,
    STEPS_APPLIED,
    POISONED,
    TAIL_LENGTH,
    SNAPSHOT_VERSION,
    SNAPSHOT_BYTES,
    DOC_BYTES,
    MARKDOWN_BYTES,
    TAIL_TRIMMED,
    CLOSE_REASON,
    ERROR_TYPE,
)


# --- Spans ----------------------------------------------------------------
#
# All SpanKind.INTERNAL (the kit default). Names are fixed strings; nothing
# is composed at runtime, so no entry needs prefix= or dynamic=.
#
# There is deliberately NO paper.db.query span: since datasette #2862 every
# PaperDB call already gets core's db.query span (kind CLIENT, attribute
# datasette.callback). Paper's additions are naming those callables and the
# paper.db.query.duration per-helper histogram below.

EVENTS_SUBMIT = SpanName(
    "paper.events.submit",
    "One write pipeline end to end — a collab step POST "
    "(``Instance.add_events``), a markdown append "
    "(``Instance.append_fragment``) or an agent read-modify-write "
    "(``Instance.apply_markdown_edit``) — including the wait for the "
    "per-doc write lock. Status is ``ERROR`` only for an unexpected "
    "exception; ``conflict`` / ``bad_version`` / ``invalid_step`` and "
    "friends are outcomes, not errors: they are the protocol working.",
    (DOC_ID, ORIGIN, OUTCOME, STEP_COUNT, BATCH_BYTES, SUBSCRIBERS),
)
WRITE_LOCK_WAIT = SpanName(
    "paper.write_lock.wait",
    "Time between asking for the instance's ``_write_lock`` and holding "
    "it, emitted with explicit start/end times (the ``db.write.queue_wait`` "
    "idiom). Always emitted, including a zero wait, so the histogram's p50 "
    "is honest.",
    (DOC_ID,),
)
VALIDATE_STEPS = SpanName(
    "paper.validate_steps",
    "``Instance._validate_steps`` — prosemirror-py ``Step.apply`` per step, "
    "on the event loop.",
    (STEP_COUNT,),
)
BROADCAST = SpanName(
    "paper.broadcast",
    "The subscriber fan-out loop in ``_persist_and_broadcast``. "
    "``put_nowait`` is cheap; the span is for the count and to show "
    "ordering relative to the write.",
    (SUBSCRIBERS, BATCH_BYTES),
)
REINDEX = SpanName(
    "paper.reindex",
    "One derived-index rebuild (``reindex_links`` / ``reindex_tags`` / "
    "``reindex_tasks``) — three per write. Status ``ERROR`` when the "
    "swallowed exception path fires (the write still succeeds; the log "
    "line stays).",
    (DOC_ID, INDEX),
)
SNAPSHOT = SpanName(
    "paper.snapshot",
    "``Instance.record_client_doc`` when it actually writes a snapshot "
    "(the below-threshold no-op emits nothing).",
    (DOC_ID, TRIGGER, SNAPSHOT_BYTES, TAIL_TRIMMED),
)
MATERIALIZE = SpanName(
    "paper.materialize",
    "``Instance.materialize_live_doc`` — snapshot parse plus step replay, "
    "**synchronous on the event loop**. This span is the one that explains "
    "a slow trace whose SQL is fast.",
    (DOC_ID, CACHE_HIT, STEPS_APPLIED, POISONED),
)
INSTANCE_HYDRATE = SpanName(
    "paper.instance.hydrate",
    "``Instance.hydrate`` — the cold start after LRU eviction: latest "
    "snapshot plus the step tail, loaded from the internal database.",
    (DOC_ID, SNAPSHOT_VERSION, TAIL_LENGTH),
)
MARKDOWN_PARSE = SpanName(
    "paper.markdown.parse",
    "``markdown_to_doc`` / ``markdown_to_fragment`` on a request path — "
    "the append route, create-from-markdown, and the agent tools. Not the "
    "CLI.",
    (MARKDOWN_BYTES,),
)
MARKDOWN_SERIALIZE = SpanName(
    "paper.markdown.serialize",
    "``doc_to_markdown`` on a request path — ``/document``, "
    "``apply_markdown_edit`` and the agent ``read_paper`` tool. Not the "
    "CLI.",
    (DOC_BYTES,),
)

SPANS = (
    EVENTS_SUBMIT,
    WRITE_LOCK_WAIT,
    VALIDATE_STEPS,
    BROADCAST,
    REINDEX,
    SNAPSHOT,
    MATERIALIZE,
    INSTANCE_HYDRATE,
    MARKDOWN_PARSE,
    MARKDOWN_SERIALIZE,
)


# --- Metrics --------------------------------------------------------------

# Levels: observable gauges. Callbacks read the live InstanceRegistry
# objects through a weak set (telemetry.py); with no provider installed
# they are never invoked.

M_SSE_STREAMS_OPEN = MetricName(
    "paper.sse.streams.open",
    GAUGE,
    "{stream}",
    "Open SSE subscriber queues, summed over live instances. The first "
    "question about a collab server.",
)
M_INSTANCES_LIVE = MetricName(
    "paper.instances.live",
    GAUGE,
    "{instance}",
    "Hydrated ``Instance`` objects in the registry — occupancy against "
    "``MAX_INSTANCES``.",
)
M_STEPS_TAIL_MAX = MetricName(
    "paper.steps_tail.max",
    GAUGE,
    "{step}",
    "The longest in-memory step tail over live instances. Climbing toward "
    "``MAX_TAIL`` means snapshotting is behind and 410s are next. Max "
    "rather than per-doc to keep it attribute-free.",
)
M_INSTANCES_POISONED = MetricName(
    "paper.instances.poisoned",
    GAUGE,
    "{instance}",
    "Live instances carrying a materialization error (a step in history "
    "that no longer applies). Alert on nonzero.",
)
M_PRESENCE_CLIENTS = MetricName(
    "paper.presence.clients",
    GAUGE,
    "{client}",
    "Presence entries summed over live instances — clients with a live "
    "cursor on some doc.",
)

# Events: counters.

M_EVENTS_SUBMITTED = MetricName(
    "paper.events.submitted",
    COUNTER,
    "{batch}",
    "Step-batch submissions by outcome and origin. The 409 rate is "
    "contention, the 410 rate is eviction, the 422 rate is a client bug "
    "or abuse.",
    (OUTCOME, ORIGIN),
)
M_INSTANCES_HYDRATED = MetricName(
    "paper.instances.hydrated",
    COUNTER,
    "{instance}",
    "Instance cache misses — hydrates from the database.",
)
M_INSTANCES_EVICTED = MetricName(
    "paper.instances.evicted",
    COUNTER,
    "{instance}",
    "LRU evictions from the instance registry. Constant churn means the "
    "cap is too low and every request rehydrates.",
)
M_SSE_STREAMS_CLOSED = MetricName(
    "paper.sse.streams.closed",
    COUNTER,
    "{stream}",
    "SSE streams closed, by reason — separates flaky clients from "
    "revocations and send failures.",
    (CLOSE_REASON,),
)
M_SSE_BACKLOG_GONE = MetricName(
    "paper.sse.backlog.gone",
    COUNTER,
    "{request}",
    "410s on the SSE subscribe — the requested version fell off the step "
    "tail. Distinct from the POST outcome counter.",
)
M_REINDEX_FAILURES = MetricName(
    "paper.reindex.failures",
    COUNTER,
    "{failure}",
    "Derived-index rebuild failures, by index. Swallowed and logged today; "
    "nothing else surfaces them.",
    (INDEX,),
)
M_SNAPSHOTS_WRITTEN = MetricName(
    "paper.snapshots.written",
    COUNTER,
    "{snapshot}",
    "Snapshots persisted, by trigger. Confirms API-only docs snapshot at all.",
    (TRIGGER,),
)

# Distributions: histograms. Durations in seconds on core's
# DURATION_BUCKETS; counts, bytes and stream lifetimes on their own axes.

M_EVENTS_DURATION = MetricName(
    "paper.events.duration",
    HISTOGRAM,
    "s",
    "The whole submit pipeline, end to end — the metric that survives trace sampling.",
    (OUTCOME, ORIGIN),
    buckets=DURATION_BUCKETS,
)
M_WRITE_LOCK_WAIT = MetricName(
    "paper.write_lock.wait",
    HISTOGRAM,
    "s",
    "Time spent waiting for a doc's write lock — per-doc contention that "
    "Datasette's write-queue gauge cannot see.",
    buckets=DURATION_BUCKETS,
)
M_MATERIALIZE_DURATION = MetricName(
    "paper.materialize.duration",
    HISTOGRAM,
    "s",
    "``materialize_live_doc`` — event-loop blocking time, split by cache hit.",
    (CACHE_HIT,),
    buckets=DURATION_BUCKETS,
)
M_HYDRATE_DURATION = MetricName(
    "paper.hydrate.duration",
    HISTOGRAM,
    "s",
    "``Instance.hydrate`` — the cold-start cost.",
    buckets=DURATION_BUCKETS,
)
M_DB_QUERY_DURATION = MetricName(
    "paper.db.query.duration",
    HISTOGRAM,
    "s",
    "Per-helper query latency, keyed by ``paper.query_name``. This "
    "deliberately double-measures with core's "
    "``db.client.operation.duration`` — two scopes, two series, one trace: "
    "core's series carries ``db.namespace`` and friends, this one the "
    "per-callback dimension core deliberately does not put on a metric.",
    (QUERY_NAME, OPERATION, ERROR_TYPE),
    buckets=DURATION_BUCKETS,
)
M_BROADCAST_FANOUT = MetricName(
    "paper.broadcast.fanout",
    HISTOGRAM,
    "{subscriber}",
    "Subscribers each accepted batch fanned out to.",
    buckets=COUNT_BUCKETS,
)
M_EVENTS_BATCH_BYTES = MetricName(
    "paper.events.batch_bytes",
    HISTOGRAM,
    "By",
    "Serialized size of each accepted step batch.",
    buckets=BYTE_BUCKETS,
)
M_SSE_STREAM_DURATION = MetricName(
    "paper.sse.stream.duration",
    HISTOGRAM,
    "s",
    "SSE connection lifetime, by close reason.",
    (CLOSE_REASON,),
    buckets=STREAM_BUCKETS,
)

METRICS = (
    M_SSE_STREAMS_OPEN,
    M_INSTANCES_LIVE,
    M_STEPS_TAIL_MAX,
    M_INSTANCES_POISONED,
    M_PRESENCE_CLIENTS,
    M_EVENTS_SUBMITTED,
    M_INSTANCES_HYDRATED,
    M_INSTANCES_EVICTED,
    M_SSE_STREAMS_CLOSED,
    M_SSE_BACKLOG_GONE,
    M_REINDEX_FAILURES,
    M_SNAPSHOTS_WRITTEN,
    M_EVENTS_DURATION,
    M_WRITE_LOCK_WAIT,
    M_MATERIALIZE_DURATION,
    M_HYDRATE_DURATION,
    M_DB_QUERY_DURATION,
    M_BROADCAST_FANOUT,
    M_EVENTS_BATCH_BYTES,
    M_SSE_STREAM_DURATION,
)
