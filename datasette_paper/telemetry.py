"""OpenTelemetry integration for datasette-paper.
@feat telemetry: tracer, meter, instruments, gauge callbacks, helpers.

Depends on ``opentelemetry-api`` only — this module never creates a
``TracerProvider`` or ``MeterProvider``, never configures an exporter, and
must never import ``opentelemetry.sdk`` (a test imports the package in a
fresh subprocess and checks). With no provider installed every span is a
``NonRecordingSpan``, every instrument a no-op, and the observable-gauge
callbacks are never invoked — turning telemetry on is the operator
installing a provider (``opentelemetry-instrument``, an embedding app),
exactly as in Datasette core.

This module is imported by ``instance.py``, ``db.py`` and the routes; it
must not import any of them at module level. Gauge callbacks reach the
instance registries through a weak set instead (see the bottom of the
file).

Instruments are module-level: OpenTelemetry's ``_ProxyMeter`` forwards to a
provider installed later. The ``ProxyTracer`` resolves and **caches** a
concrete tracer on first use, so the test harness installs its provider in
a session-scoped autouse fixture before any span is created; under
``opentelemetry-instrument`` the provider exists before this module is
imported.
"""

from __future__ import annotations

import threading
import time
import weakref
from contextlib import contextmanager
from importlib import metadata

from opentelemetry import metrics as otel_metrics
from opentelemetry import trace as otel_trace
from opentelemetry.trace import Status, StatusCode

from .errors import BadVersionError, ConflictError, GoneError, InvalidStepError
from .telemetry_registry import (
    DOC_BYTES,
    DOC_ID,
    ERROR_TYPE,
    EVENTS_SUBMIT,
    M_BROADCAST_FANOUT,
    M_DB_QUERY_DURATION,
    M_EVENTS_BATCH_BYTES,
    M_EVENTS_DURATION,
    M_EVENTS_SUBMITTED,
    M_HYDRATE_DURATION,
    M_INSTANCES_EVICTED,
    M_INSTANCES_HYDRATE_JOINED,
    M_INSTANCES_HYDRATED,
    M_INSTANCES_LIVE,
    M_INSTANCES_POISONED,
    M_INSTANCES_RECLAIMED,
    M_MATERIALIZE_DURATION,
    M_PRESENCE_CLIENTS,
    M_REINDEX_FAILURES,
    M_SNAPSHOTS_WRITTEN,
    M_SSE_BACKLOG_GONE,
    M_SSE_STREAM_DURATION,
    M_SSE_STREAMS_CLOSED,
    M_SSE_STREAMS_OPEN,
    M_STEPS_TAIL_MAX,
    M_WRITE_LOCK_WAIT,
    MARKDOWN_BYTES,
    MARKDOWN_PARSE,
    MARKDOWN_SERIALIZE,
    OPERATION,
    ORIGIN,
    OUTCOME,
    QUERY_NAME,
    STEP_COUNT,
    WRITE_LOCK_WAIT,
)


def _version() -> str:
    try:
        return metadata.version("datasette-paper")
    except metadata.PackageNotFoundError:
        # Uninstalled checkout (running straight from a source tree).
        return "0"


# Scope name is the import package name, per the plugin telemetry docs'
# naming rules — consumers filter on it. No schema URL: every name paper
# emits is under paper.* and outside semantic conventions.
tracer = otel_trace.get_tracer("datasette_paper", _version())
meter = otel_metrics.get_meter("datasette_paper", _version())


def clamp(value, allowed, default):
    """Clamp an attribute value to its registry enum.

    Enum attributes declare a closed ``values=`` set in the registry and the
    conformance helpers enforce membership; this is the call-site half of
    that promise — anything unexpected becomes ``default`` instead of
    minting a new metric series.
    """
    return value if value in allowed else default


# --- Instruments ----------------------------------------------------------
#
# Each instrument passes the SDK a short plain-text description; the
# registry entry carries the longer documentation for docs/TELEMETRY.md.


def _histogram(entry, description):
    return meter.create_histogram(
        entry,
        unit=entry.unit,
        description=description,
        explicit_bucket_boundaries_advisory=entry.buckets,
    )


def _counter(entry, description):
    return meter.create_counter(entry, unit=entry.unit, description=description)


events_submitted = _counter(
    M_EVENTS_SUBMITTED, "Step-batch submissions by outcome and origin"
)
instances_hydrated = _counter(M_INSTANCES_HYDRATED, "Real instance hydrates")
instances_hydrate_joined = _counter(
    M_INSTANCES_HYDRATE_JOINED, "Registry misses that joined an in-flight hydrate"
)
instances_reclaimed = _counter(
    M_INSTANCES_RECLAIMED, "Evicted instances handed back instead of rehydrated"
)
instances_evicted = _counter(
    M_INSTANCES_EVICTED, "LRU evictions from the instance registry"
)
sse_streams_closed = _counter(M_SSE_STREAMS_CLOSED, "SSE streams closed, by reason")
sse_backlog_gone = _counter(
    M_SSE_BACKLOG_GONE, "SSE subscribes at history that fell off the tail"
)
reindex_failures = _counter(
    M_REINDEX_FAILURES, "Derived-index rebuild failures, by index"
)
snapshots_written = _counter(M_SNAPSHOTS_WRITTEN, "Snapshots persisted, by trigger")

events_duration = _histogram(M_EVENTS_DURATION, "The whole submit pipeline end to end")
write_lock_wait = _histogram(
    M_WRITE_LOCK_WAIT, "Time spent waiting for a doc's write lock"
)
materialize_duration = _histogram(
    M_MATERIALIZE_DURATION, "materialize_live_doc event-loop blocking time"
)
hydrate_duration = _histogram(M_HYDRATE_DURATION, "Instance hydrate cold-start cost")
db_query_duration = _histogram(
    M_DB_QUERY_DURATION, "Per-helper query latency, keyed by paper.query_name"
)
broadcast_fanout = _histogram(
    M_BROADCAST_FANOUT, "Subscribers each accepted batch fanned out to"
)
events_batch_bytes = _histogram(
    M_EVENTS_BATCH_BYTES, "Serialized size of each accepted step batch"
)
sse_stream_duration = _histogram(
    M_SSE_STREAM_DURATION, "SSE connection lifetime, by close reason"
)


# --- Helpers --------------------------------------------------------------


@contextmanager
def db_query_timer(query_name: str, operation: str):
    """Record ``paper.db.query.duration`` for one query helper call.

    The ``record_operation_duration`` idiom from Datasette's telemetry
    module: ``error.type`` is set from the exception class on failure so
    the latency distribution splits by success and failure. **No span** —
    the trace side is core's ``db.query`` span, which identifies the same
    call via ``datasette.callback`` once the callables are named.
    """
    attributes = {QUERY_NAME: query_name, OPERATION: operation}
    started = time.perf_counter()
    try:
        yield
    except BaseException as exception:
        attributes[ERROR_TYPE] = type(exception).__qualname__
        raise
    finally:
        db_query_duration.record(time.perf_counter() - started, attributes)


@contextmanager
def markdown_parse_span(markdown_text: str):
    """``paper.markdown.parse`` around a request-path ``markdown_to_doc`` /
    ``markdown_to_fragment`` call. Records the input's byte length only —
    never the text. Wrap the *call site*, not the parser module, so the
    CLI and ``export.py`` stay span-free.
    """
    with tracer.start_as_current_span(MARKDOWN_PARSE) as span:
        if span.is_recording():
            span.set_attribute(MARKDOWN_BYTES, len(markdown_text))
        yield


@contextmanager
def markdown_serialize_span(doc_bytes: int | None = None):
    """``paper.markdown.serialize`` around a request-path
    ``doc_to_markdown`` call. ``doc_bytes`` is the length of the JSON doc
    fed in (a size, never the doc) — pass None when no cheap serialized
    form is at hand rather than serializing just to measure.
    """
    with tracer.start_as_current_span(MARKDOWN_SERIALIZE) as span:
        if span.is_recording() and doc_bytes is not None:
            span.set_attribute(DOC_BYTES, doc_bytes)
        yield


@contextmanager
def submit_pipeline(doc_id: int, origin: str, step_count: int | None = None):
    """Wrap one write pipeline in ``paper.events.submit`` end to end.
    @feat telemetry: the submit span + outcome counter + duration histogram.

    Yields a mutable state dict whose ``"outcome"`` key the body may set
    for non-exception outcomes (``"empty"``, a no-op edit); exceptions map
    to their protocol outcome here. Every exit path — return, protocol
    error, unexpected exception — stamps ``paper.outcome`` on the span and
    records ``paper.events.submitted`` / ``paper.events.duration`` with
    ``{outcome, origin}``. Only an *unexpected* exception sets span status
    ``ERROR``: conflicts, bad versions, gone history and invalid steps are
    the protocol working.
    """
    origin = clamp(origin, ORIGIN.values, "api")
    started = time.perf_counter()
    state = {"outcome": "ok"}
    # record_exception / set_status_on_exception are off because a
    # ConflictError escaping this block is a 409 on its way to the client,
    # not a failure — the SDK default would stamp ERROR on every protocol
    # outcome. The unexpected-exception branch below sets ERROR itself.
    with tracer.start_as_current_span(
        EVENTS_SUBMIT, record_exception=False, set_status_on_exception=False
    ) as span:
        if span.is_recording():
            span.set_attribute(DOC_ID, doc_id)
            span.set_attribute(ORIGIN, origin)
            if step_count is not None:
                span.set_attribute(STEP_COUNT, step_count)
        try:
            yield state
        except BadVersionError:
            state["outcome"] = "bad_version"
            raise
        except ConflictError:
            state["outcome"] = "conflict"
            raise
        except GoneError:
            state["outcome"] = "gone"
            raise
        except InvalidStepError:
            state["outcome"] = "invalid_step"
            raise
        except BaseException:
            state["outcome"] = "error"
            span.set_status(Status(StatusCode.ERROR))
            raise
        finally:
            outcome = clamp(state["outcome"], OUTCOME.values, "error")
            if span.is_recording():
                span.set_attribute(OUTCOME, outcome)
            attributes = {OUTCOME: outcome, ORIGIN: origin}
            events_submitted.add(1, attributes)
            events_duration.record(time.perf_counter() - started, attributes)


def record_write_lock_wait(doc_id: int, start_time_ns: int, end_time_ns: int) -> None:
    """Emit the ``paper.write_lock.wait`` span and histogram for one wait.

    Explicit start/end times rather than a ``with`` block — the
    ``db.write.queue_wait`` idiom: the span's duration is the time actually
    spent waiting for the lock, not the near-zero time spent constructing
    the span object here. Always emitted, including a zero wait, so the
    histogram's p50 is honest.
    """
    span = tracer.start_span(WRITE_LOCK_WAIT, start_time=start_time_ns)
    if span.is_recording():
        span.set_attribute(DOC_ID, doc_id)
    span.end(end_time=end_time_ns)
    write_lock_wait.record((end_time_ns - start_time_ns) / 1e9)


# --- Gauge plumbing -------------------------------------------------------
#
# Live InstanceRegistry objects, weakly held so instrumenting a registry
# never keeps it (or the Datasette it hangs off) alive — the test suite
# creates hundreds of Datasette instances and nothing ever unregisters;
# weakness is the whole mechanism. Guarded by a lock because gauge
# callbacks run on the SDK's collection thread while the event loop may be
# creating registries. Hand-rolled after the `_live_datasettes` block in
# datasette/telemetry.py — the kit exports no helper for this.
#
# Callback discipline (from the plugin telemetry docs): never await, never
# take a lock the request path holds (in particular never an instance's
# `_write_lock`), read only cheap in-memory state. `dict.values()` /
# `len()` on the registry's plain dicts are atomic enough.

_live_registries = weakref.WeakSet()
_live_registries_lock = threading.Lock()


def register_instance_registry(registry) -> None:
    "Start reporting instance/SSE gauges for this InstanceRegistry."
    with _live_registries_lock:
        _live_registries.add(registry)


def _registries():
    with _live_registries_lock:
        return list(_live_registries)


def _instances():
    for registry in _registries():
        yield from list(registry._instances.values())


# Each callback is a plain generator function so it can be unit-tested
# directly, without standing up an SDK provider and a metric reader. With
# no provider installed none of them ever runs.


def observe_open_streams(options=None):
    "Open SSE subscriber queues, summed over live instances."
    total = sum(len(instance.subscribers) for instance in _instances())
    yield otel_metrics.Observation(total, {})


def observe_live_instances(options=None):
    "Hydrated Instance objects per registry."
    for registry in _registries():
        yield otel_metrics.Observation(len(registry._instances), {})


def observe_tail_max(options=None):
    "The longest in-memory step tail over live instances."
    longest = max((len(instance.steps_tail) for instance in _instances()), default=0)
    yield otel_metrics.Observation(longest, {})


def observe_poisoned(options=None):
    "Live instances carrying a materialization error."
    poisoned = sum(
        1 for instance in _instances() if instance._materialization_error is not None
    )
    yield otel_metrics.Observation(poisoned, {})


def observe_presence_clients(options=None):
    "Presence entries summed over live instances."
    total = sum(len(instance.presence) for instance in _instances())
    yield otel_metrics.Observation(total, {})


sse_streams_open_gauge = meter.create_observable_gauge(
    M_SSE_STREAMS_OPEN,
    callbacks=[observe_open_streams],
    unit=M_SSE_STREAMS_OPEN.unit,
    description="Open SSE subscriber queues over live instances",
)

instances_live_gauge = meter.create_observable_gauge(
    M_INSTANCES_LIVE,
    callbacks=[observe_live_instances],
    unit=M_INSTANCES_LIVE.unit,
    description="Hydrated Instance objects in the registry",
)

steps_tail_max_gauge = meter.create_observable_gauge(
    M_STEPS_TAIL_MAX,
    callbacks=[observe_tail_max],
    unit=M_STEPS_TAIL_MAX.unit,
    description="Longest in-memory step tail over live instances",
)

instances_poisoned_gauge = meter.create_observable_gauge(
    M_INSTANCES_POISONED,
    callbacks=[observe_poisoned],
    unit=M_INSTANCES_POISONED.unit,
    description="Live instances carrying a materialization error",
)

presence_clients_gauge = meter.create_observable_gauge(
    M_PRESENCE_CLIENTS,
    callbacks=[observe_presence_clients],
    unit=M_PRESENCE_CLIENTS.unit,
    description="Presence entries summed over live instances",
)
