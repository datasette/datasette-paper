"""Span behaviour for paper's OpenTelemetry instrumentation.

Skips as a module when the OpenTelemetry SDK is not installed (it is a
dev-group dependency only). The one exception is the subprocess test,
which needs no provider — but it needs the SDK absent from the *package's*
import graph, which is exactly what it proves.
"""

import importlib.metadata

import pytest

pytest.importorskip("opentelemetry.sdk")

from datasette.telemetry_testing import assert_package_never_imports_sdk  # noqa: E402

from datasette_paper import telemetry  # noqa: E402


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
