"""Metric collection for the load benchmarker.

One :class:`Metrics` per run, shared by every simulated user. Everything
is in-memory (latency samples are plain lists; a 100-user, 30-minute run
is a few hundred thousand floats) and summarised once at the end.
"""

from __future__ import annotations

import collections
import statistics
import time
from dataclasses import dataclass, field


BENCH_CPU_LIMIT_PCT = 70.0
LOOP_LAG_LIMIT_S = 0.05


def percentiles(samples: list[float]) -> dict:
    if not samples:
        return {"n": 0}
    s = sorted(samples)
    n = len(s)

    def pct(p: float) -> float:
        k = min(n - 1, max(0, int(round(p / 100 * (n - 1)))))
        return s[k]

    return {
        "n": n,
        "p50_ms": round(pct(50) * 1000, 1),
        "p95_ms": round(pct(95) * 1000, 1),
        "p99_ms": round(pct(99) * 1000, 1),
        "max_ms": round(s[-1] * 1000, 1),
        "mean_ms": round(statistics.fmean(s) * 1000, 1),
    }


def slope_mb_per_min(samples: list[tuple[float, float]]) -> float | None:
    """Least-squares slope of (t_seconds, rss_bytes) → MB/min."""
    if len(samples) < 3:
        return None
    xs = [t for t, _ in samples]
    ys = [b for _, b in samples]
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return None
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom
    return slope * 60 / (1024 * 1024)


@dataclass
class Metrics:
    t0: float = field(default_factory=time.monotonic)
    # route → latency samples (seconds)
    latency: dict[str, list[float]] = field(
        default_factory=lambda: collections.defaultdict(list)
    )
    # route → status → count
    status: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter)
    )
    # route → exception class → count
    errors: dict[str, collections.Counter] = field(
        default_factory=lambda: collections.defaultdict(collections.Counter)
    )
    # reason → count (why a stream was reopened)
    reconnects: collections.Counter = field(default_factory=collections.Counter)
    resets: int = 0  # in-band `reset` events + 410s
    gaps: int = 0  # version gaps detected on the stream
    stream_errors: collections.Counter = field(default_factory=collections.Counter)
    event_lag: list[float] = field(default_factory=list)
    steps_sent: int = 0
    steps_received: int = 0
    # (t, rss_bytes) — whole run; the hold-phase slope is computed from a slice
    rss: list[tuple[float, float]] = field(default_factory=list)
    cpu: list[tuple[float, float]] = field(default_factory=list)
    # Bench self-check: our own CPU % and event-loop lag (sleep drift), so a
    # starved client can't be mistaken for a slow server.
    bench_cpu: list[tuple[float, float]] = field(default_factory=list)
    loop_lag: list[tuple[float, float]] = field(default_factory=list)
    debug_instances: list[tuple[float, dict]] = field(default_factory=list)
    phases: dict[str, float] = field(default_factory=dict)  # name → t (s since t0)
    user_counts: list[tuple[float, int]] = field(default_factory=list)
    docs_created: int = 0
    docs_trashed: int = 0
    # sender-registered send times, keyed (doc_id, client_id, version_after)
    pending_lag: dict[tuple[int, int, int], float] = field(default_factory=dict)

    def now(self) -> float:
        return time.monotonic() - self.t0

    def merge(self, other: "Metrics") -> None:
        """Fold a worker process's metrics into this (main-process) one.

        Server-side series (rss/cpu/debug_instances) and phases stay the
        main process's; everything users produce is concatenated.
        """
        for route, samples in other.latency.items():
            self.latency[route].extend(samples)
        for route, counter in other.status.items():
            self.status[route].update(counter)
        for route, counter in other.errors.items():
            self.errors[route].update(counter)
        self.reconnects.update(other.reconnects)
        self.stream_errors.update(other.stream_errors)
        self.resets += other.resets
        self.gaps += other.gaps
        self.event_lag.extend(other.event_lag)
        self.steps_sent += other.steps_sent
        self.steps_received += other.steps_received
        self.docs_created += other.docs_created
        self.docs_trashed += other.docs_trashed
        self.bench_cpu.extend(other.bench_cpu)
        self.loop_lag.extend(other.loop_lag)
        self.bench_cpu.sort()
        self.loop_lag.sort()

    def mark(self, phase: str) -> None:
        self.phases[phase] = self.now()

    def record(self, route: str, status: int, elapsed: float) -> None:
        self.latency[route].append(elapsed)
        self.status[route][status] += 1

    def error(self, route: str, exc: BaseException) -> None:
        self.errors[route][type(exc).__name__] += 1

    # -- event lag --------------------------------------------------------

    def lag_register(self, doc_id: int, client_id: int, version_after: int) -> None:
        self.pending_lag[(doc_id, client_id, version_after)] = time.monotonic()
        if len(self.pending_lag) > 5000:  # forget stale (409'd) entries
            for k in list(self.pending_lag)[:1000]:
                self.pending_lag.pop(k, None)

    def lag_observe(self, doc_id: int, client_id: int, version_after: int) -> None:
        t = self.pending_lag.get((doc_id, client_id, version_after))
        if t is not None:
            self.event_lag.append(time.monotonic() - t)

    # -- summary ----------------------------------------------------------

    def summary(self, hold_slope_threshold_mb_min: float) -> dict:
        hold_start = self.phases.get("hold")
        hold_end = self.phases.get("hold_end", self.now())
        hold_rss = [
            (t, b)
            for t, b in self.rss
            if hold_start is not None and hold_start <= t <= hold_end
        ]
        hold_slope = slope_mb_per_min(hold_rss)
        total_slope = slope_mb_per_min(self.rss)
        routes = sorted(set(self.latency) | set(self.status) | set(self.errors))
        total_req = sum(sum(c.values()) for c in self.status.values())
        events_status = self.status.get("events", collections.Counter())
        events_total = sum(events_status.values()) or 1
        out = {
            "duration_s": round(self.now(), 1),
            "phases": {k: round(v, 1) for k, v in self.phases.items()},
            "requests_total": total_req,
            "routes": {
                r: {
                    "latency": percentiles(self.latency.get(r, [])),
                    "status": dict(sorted(self.status.get(r, {}).items())),
                    "errors": dict(self.errors.get(r, {})),
                }
                for r in routes
            },
            "events": {
                "posts": sum(events_status.values()),
                "rate_409": round(events_status.get(409, 0) / events_total, 4),
                "rate_410": round(events_status.get(410, 0) / events_total, 4),
                "steps_sent": self.steps_sent,
                "steps_received": self.steps_received,
            },
            "sse": {
                "reconnects": dict(self.reconnects),
                "reconnects_total": sum(self.reconnects.values()),
                "resets": self.resets,
                "gaps": self.gaps,
                "stream_errors": dict(self.stream_errors),
            },
            "event_lag": percentiles(self.event_lag),
            "docs": {"created": self.docs_created, "trashed": self.docs_trashed},
            "rss": {
                "samples": len(self.rss),
                "start_mb": round(self.rss[0][1] / 2**20, 1) if self.rss else None,
                "end_mb": round(self.rss[-1][1] / 2**20, 1) if self.rss else None,
                "peak_mb": round(max(b for _, b in self.rss) / 2**20, 1)
                if self.rss
                else None,
                "hold_start_mb": round(hold_rss[0][1] / 2**20, 1) if hold_rss else None,
                "hold_end_mb": round(hold_rss[-1][1] / 2**20, 1) if hold_rss else None,
                "hold_slope_mb_per_min": round(hold_slope, 2)
                if hold_slope is not None
                else None,
                "total_slope_mb_per_min": round(total_slope, 2)
                if total_slope is not None
                else None,
                "threshold_mb_per_min": hold_slope_threshold_mb_min,
                "hold_slope_ok": (hold_slope is None)
                or (hold_slope <= hold_slope_threshold_mb_min),
            },
            "cpu_pct": percentiles([c for _, c in self.cpu]) if self.cpu else {"n": 0},
            "bench_self": self._self_check(),
            "debug_instances": {
                "samples": len(self.debug_instances),
                "last": self.debug_instances[-1][1] if self.debug_instances else None,
            },
        }
        return out

    def _self_check(self) -> dict:
        """Is the bench process itself keeping up? Latency numbers are only
        trustworthy when our CPU stays under ~70 % and the event loop's
        sleep drift under ~50 ms; otherwise queueing happens on our side."""
        cpu = [c for _, c in self.bench_cpu]
        lag = [x for _, x in self.loop_lag]
        cpu_hot = sum(1 for c in cpu if c > BENCH_CPU_LIMIT_PCT)
        lag_hot = sum(1 for x in lag if x > LOOP_LAG_LIMIT_S)
        # percentiles() scales by 1000 for ms; feed CPU/1000 so *_ms == %.
        cpu_p = percentiles([c / 1000 for c in cpu]) if cpu else {"n": 0}
        cpu_out = {k.replace("_ms", "_pct"): v for k, v in cpu_p.items()}
        return {
            "cpu": cpu_out,
            "loop_lag": percentiles(lag) if lag else {"n": 0},
            "cpu_samples_over_limit": cpu_hot,
            "lag_samples_over_limit": lag_hot,
            "cpu_limit_pct": BENCH_CPU_LIMIT_PCT,
            "lag_limit_ms": LOOP_LAG_LIMIT_S * 1000,
            # Untrustworthy if more than 10 % of samples breached either limit.
            "latency_trustworthy": (
                cpu_hot <= max(1, len(cpu) // 10) and lag_hot <= max(1, len(lag) // 10)
            ),
        }

    def raw(self) -> dict:
        """Time series for the JSON file (small enough to keep)."""
        return {
            "rss": [(round(t, 1), b) for t, b in self.rss],
            "cpu": [(round(t, 1), c) for t, c in self.cpu],
            "bench_cpu": [(round(t, 1), c) for t, c in self.bench_cpu],
            "loop_lag": [(round(t, 1), round(x * 1000, 1)) for t, x in self.loop_lag],
            "user_counts": [(round(t, 1), n) for t, n in self.user_counts],
            "debug_instances": [(round(t, 1), d) for t, d in self.debug_instances],
        }


def format_summary(s: dict, label: str = "") -> str:
    lines = []
    head = f"datasette-paper bench {label}".strip()
    lines.append(head)
    lines.append("=" * len(head))
    ph = s["phases"]
    lines.append(
        f"duration {s['duration_s']}s  phases: "
        + ", ".join(f"{k}@{v}s" for k, v in ph.items())
    )
    sc = s.get("bench_self") or {}
    if sc and not sc["cpu"].get("n"):
        lines.append("bench self-check: no samples (workers did not report?)")
    elif sc and not sc.get("latency_trustworthy", True):
        lines.append(
            "WARNING: bench process starved — CPU p95 "
            f"{sc['cpu'].get('p95_pct')}% (limit {sc['cpu_limit_pct']}%), loop lag p95 "
            f"{sc['loop_lag'].get('p95_ms')} ms / max {sc['loop_lag'].get('max_ms')} ms "
            f"(limit {sc['lag_limit_ms']} ms). LATENCY NUMBERS BELOW ARE UNTRUSTWORTHY; "
            "use --workers or fewer users per process."
        )
    elif sc:
        lines.append(
            f"bench self-check OK: CPU p50 {sc['cpu'].get('p50_pct')}% p95 "
            f"{sc['cpu'].get('p95_pct')}%, loop lag p95 {sc['loop_lag'].get('p95_ms')} ms "
            f"max {sc['loop_lag'].get('max_ms')} ms"
        )
    r = s["rss"]
    if r["samples"]:
        verdict = "PASS" if r["hold_slope_ok"] else "FAIL"
        lines.append(
            f"RSS: start {r['start_mb']} MB  end {r['end_mb']} MB  peak {r['peak_mb']} MB"
        )
        lines.append(
            f"RSS hold slope: {r['hold_slope_mb_per_min']} MB/min "
            f"(hold {r['hold_start_mb']} → {r['hold_end_mb']} MB; "
            f"threshold {r['threshold_mb_per_min']} MB/min) → {verdict}"
        )
    else:
        lines.append("RSS: not sampled (no --serve)")
    if s["cpu_pct"].get("n"):
        lines.append(
            f"server CPU %: p50 {s['cpu_pct']['p50_ms'] / 1000:.0f}  p95 {s['cpu_pct']['p95_ms'] / 1000:.0f}"
        )
    ev = s["events"]
    lines.append(
        f"events POSTs {ev['posts']}  409 rate {ev['rate_409']:.1%}  "
        f"410 rate {ev['rate_410']:.1%}  steps sent {ev['steps_sent']}  "
        f"received {ev['steps_received']}"
    )
    sse = s["sse"]
    lines.append(
        f"SSE reconnects {sse['reconnects_total']} {sse['reconnects']}  "
        f"resets {sse['resets']}  gaps {sse['gaps']}  stream errors {sse['stream_errors']}"
    )
    lag = s["event_lag"]
    if lag.get("n"):
        lines.append(
            f"event lag (n={lag['n']}): p50 {lag['p50_ms']} ms  p95 {lag['p95_ms']} ms  "
            f"p99 {lag['p99_ms']} ms  max {lag['max_ms']} ms"
        )
    lines.append(f"docs created {s['docs']['created']}  trashed {s['docs']['trashed']}")
    lines.append("")
    lines.append(
        f"{'route':<12}{'n':>7}{'p50':>9}{'p95':>9}{'p99':>9}{'max':>9}  status / errors"
    )
    for route, info in s["routes"].items():
        lat = info["latency"]
        if lat.get("n"):
            lines.append(
                f"{route:<12}{lat['n']:>7}{lat['p50_ms']:>9}{lat['p95_ms']:>9}"
                f"{lat['p99_ms']:>9}{lat['max_ms']:>9}  {info['status']} {info['errors'] or ''}"
            )
        else:
            lines.append(
                f"{route:<12}{0:>7}{'':>36}  {info['status']} {info['errors'] or ''}"
            )
    di = s["debug_instances"]
    if di["samples"]:
        lines.append("")
        lines.append(f"debug/instances (last of {di['samples']}): {di['last']}")
    return "\n".join(lines)


def format_compare(a: dict, b: dict, a_name: str, b_name: str) -> str:
    """Side-by-side diff of the headline numbers of two result files."""
    sa, sb = a["summary"], b["summary"]
    rows: list[tuple[str, object, object]] = []

    def add(name, va, vb):
        rows.append((name, va, vb))

    add("duration_s", sa["duration_s"], sb["duration_s"])
    add("users", a["config"].get("users"), b["config"].get("users"))
    add("rss start MB", sa["rss"]["start_mb"], sb["rss"]["start_mb"])
    add("rss end MB", sa["rss"]["end_mb"], sb["rss"]["end_mb"])
    add("rss peak MB", sa["rss"]["peak_mb"], sb["rss"]["peak_mb"])
    add(
        "rss hold slope MB/min",
        sa["rss"]["hold_slope_mb_per_min"],
        sb["rss"]["hold_slope_mb_per_min"],
    )
    add("hold slope ok", sa["rss"]["hold_slope_ok"], sb["rss"]["hold_slope_ok"])
    add("requests", sa["requests_total"], sb["requests_total"])
    add("events posts", sa["events"]["posts"], sb["events"]["posts"])
    add("409 rate", sa["events"]["rate_409"], sb["events"]["rate_409"])
    add("410 rate", sa["events"]["rate_410"], sb["events"]["rate_410"])
    add("sse reconnects", sa["sse"]["reconnects_total"], sb["sse"]["reconnects_total"])
    add("sse resets", sa["sse"]["resets"], sb["sse"]["resets"])
    for side in (sa, sb):
        side.setdefault(
            "bench_self", {"cpu": {}, "loop_lag": {}, "latency_trustworthy": None}
        )
    add(
        "bench cpu p95 %",
        sa["bench_self"]["cpu"].get("p95_pct"),
        sb["bench_self"]["cpu"].get("p95_pct"),
    )
    add(
        "bench loop lag p95 ms",
        sa["bench_self"]["loop_lag"].get("p95_ms"),
        sb["bench_self"]["loop_lag"].get("p95_ms"),
    )
    add(
        "latency trustworthy",
        sa["bench_self"]["latency_trustworthy"],
        sb["bench_self"]["latency_trustworthy"],
    )
    for p in ("p50_ms", "p95_ms", "p99_ms"):
        add(f"event lag {p}", sa["event_lag"].get(p), sb["event_lag"].get(p))
    for route in sorted(set(sa["routes"]) | set(sb["routes"])):
        la = sa["routes"].get(route, {}).get("latency", {})
        lb = sb["routes"].get(route, {}).get("latency", {})
        for p in ("p50_ms", "p95_ms", "p99_ms"):
            add(f"{route} {p}", la.get(p), lb.get(p))
        ea = sum(sa["routes"].get(route, {}).get("errors", {}).values())
        eb = sum(sb["routes"].get(route, {}).get("errors", {}).values())
        add(f"{route} errors", ea, eb)

    w = max(len(r[0]) for r in rows) + 2
    out = [f"{'metric':<{w}}{a_name:>16}{b_name:>16}{'delta':>12}"]
    for name, va, vb in rows:
        delta = ""
        if (
            isinstance(va, (int, float))
            and isinstance(vb, (int, float))
            and not isinstance(va, bool)
        ):
            d = vb - va
            delta = f"{d:+.2f}" if isinstance(d, float) else f"{d:+d}"
        out.append(f"{name:<{w}}{str(va):>16}{str(vb):>16}{delta:>12}")
    return "\n".join(out)
