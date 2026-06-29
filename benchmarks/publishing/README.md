# Publishing benchmark harness

Quantifies the publishing feature's premise: a **prerendered, published** doc is
far cheaper to serve than the status quo of **many read-only users on the live
editor**. See `plans/publishing/06-benchmarking.md` for the full design.

## Run it

```
just bench-publishing
# or, with options:
uv run --prerelease=allow python benchmarks/publishing/bench.py \
    --vus 1,10,50,100 --iterations 60 --blocks 5 --rows 5000
```

`bench.py` is self-contained (like `frontend/scripts/screenshots.mjs`): it boots
a throwaway Datasette with a seeded `data` database + the query-counter plugin
(`trace_plugin.py`), seeds a doc with **K** data blocks, publishes it both
all-frozen and all-live, drives a concurrency matrix with asyncio + httpx, and
writes `results/report.md`. No external load tool is required. Server CPU/RSS are
sampled when `psutil` is importable (omitted otherwise).

## Scenarios

Same doc + data, different serving path:

| # | Name | A viewer does | Isolates |
|---|------|---------------|----------|
| **A** | status-quo (live editor) | GET editor page → GET `/document` bootstrap → K data XHRs | today's cost of read-only users |
| **B** | frozen | GET `…/publish` — one read, 0 data XHRs | the headline win |
| **C** | live | GET `…/publish` (static) → K data XHRs | value of prerendering prose alone (vs A) |

(**D — public + CDN** needs a caching proxy in front; out of scope for the local
driver. Put nginx/Varnish ahead of `BASE` and point a load tool at it to measure
the origin-offload ceiling.)

The SSE *hold* of scenario A isn't simulated by the HTTP driver (the per-viewer
DB cost is the dominant scaling term); for connection-count/memory effects of
held SSE streams, drive `/-/paper/api/docs/<id>/events` with a dedicated SSE
tool.

## Metrics

Per scenario × VU level: p50/p95/p99 latency, req/s, **SQLite statements per
page view** (read from `/-/bench/qcount` before/after each batch — the cleanest
scaling signal), and server CPU%/RSS when psutil is present.

## k6 alternative

`k6/{a_editor,b_frozen,c_live}.js` are equivalent scenarios for
[k6](https://k6.io) if you'd rather use a real ramping load tool (better
percentiles at high VU counts). They take `BASE` / `DOC` / `QUERIES` env vars —
seed a doc first (e.g. via `bench.py` or the publish API) and pass its id.

## What to expect

- **B** ≈ flat as VUs climb, ~1–2 SQLite statements/view → thousands of req/s.
- **C** below A (no editor bootstrap), but data XHRs still scale with K×VUs.
- **A** the most expensive per view; push `--vus` toward 1000 to find where its
  p95 crosses 1s — the "why publish" number.
