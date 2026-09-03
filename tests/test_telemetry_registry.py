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


async def exercise():
    """One broad workload that touches every registered span and metric.

    Filled in as tickets 02–06 land their instrumentation; finalized by
    ticket 07, which removes the xfail below.
    """
    ds, _paper = await setup_paper_datasette(actor=SENTINEL_ACTOR)
    await create_doc(ds, SENTINEL_DOC_NAME, actor_id=SENTINEL_ACTOR)


@pytest.mark.xfail(
    strict=False,
    reason="conformance workload lands with tickets 02-06; finalized in 07",
)
@pytest.mark.asyncio
async def test_conformance(otel_spans, otel_metrics):
    await exercise()
    finished = otel_spans.get_finished_spans()
    # One collect() only: the reader is delta-temporality, so anything an
    # earlier collect() drained is invisible to the coverage assertions.
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
