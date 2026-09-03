"""Dev-only console-exporter workaround (loaded via --plugins-dir by
`just dev-otel`, never installed).

The plugin telemetry kit's registry classes (Attribute / SpanName /
MetricName on datasette branch asg017/otel-phase1-6-plugin-kit) subclass
str with required __new__ arguments, which makes their instances
non-deepcopy-able. The OTel SDK's ConsoleMetricExporter renders points
with dataclasses.asdict(), which deepcopies attribute *keys* - and both
core's and paper's metric points use registry Attribute objects as keys,
so every console metrics dump dies with
`TypeError: Attribute.__new__() missing 1 required positional argument`.

Until the fix lands upstream (give the registry classes a __reduce__
that collapses to a plain str, as below), this module patches it in for
the dev harness only. Production exporters (OTLP) serialize without
deepcopy and are unaffected.
"""

from datasette import telemetry_registry as _registry


def _reduce_to_plain_str(self):
    return (str, (str(self),))


for _cls in (_registry.Attribute, _registry.SpanName, _registry.MetricName):
    _cls.__reduce__ = _reduce_to_plain_str
