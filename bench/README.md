# bench — load benchmarker

Simulates ~100 humans on a handful of shared papers so memory leaks and
latency cliffs show up locally instead of in prod. Python asyncio +
`httpx2` (the httpx fork datasette itself depends on); no plugin code
involved, everything talks to the real HTTP/SSE API.

```
just bench --users 100 --ramp 5m --hold 10m --docs 8 --doc-kb 300
just bench --users 20 --ramp 30s --hold 2m --label before --repo-path ../other-worktree
uv run --prerelease=allow --group bench python -m bench --url http://127.0.0.1:8001 --secret abc123
uv run --prerelease=allow --group bench python -m bench --compare a.json b.json
```

`just bench` passes `--serve`: it spawns `datasette` from `--repo-path`
(default: this checkout) via `uv run --project`, so pointing two runs at
two git worktrees is the A/B. The spawned server grants
`datasette-paper-create` / `paper-view` / `paper-edit` globally (like the
e2e config) and uses a fresh file-backed internal DB per run. With
`--url` the target must grant the same three and you pass its
`--secret` so the bench can sign `ds_actor` cookies.

## What a user does

Each user (`bench/user.py`) bootstraps a doc, opens the SSE stream with
its `clientID`, waits for `ready`, then loops with think-time jitter:
typing bursts (1-4 char insert steps every ~250 ms, presence POSTs
debounced at 150 ms), range deletes (some across paragraph boundaries),
multi-paragraph pastes, mark toggles, paragraph insert/delete, idle.
Snapshots are posted like the real client (100 steps since the last one,
5 s debounce). Every 1-4 min the user "reloads": new clientID,
re-bootstrap, new stream; 30 % of reloads leave the old socket open and
unread for 30 s first (the zombie-subscriber case). 409 → reopen the
stream at our version, wait for `ready`, regenerate; `reset`/410 → full
re-bootstrap; a version gap on the stream → reopen at our version.

Roles: 75 % editors on the shared pool, 20 % readers (stream + presence),
5 % creators (create a 5 KB doc, edit it 30-90 s, trash it, repeat).

Steps are real ProseMirror step JSON generated against a flat
paragraphs-of-text model (`bench/docmodel.py`) that tracks the doc from
bootstrap + every received batch. `tests/test_bench_docmodel.py` checks
the model against prosemirror-py with the paper schema.

## Output

`bench/results/<ts>.json` (config, summary, RSS/CPU time series, server
log issue counts) plus a `.txt` summary; the server log and internal DB
sit in `bench/results/<ts>/`. Headline metrics: per-route latency
p50/p95/p99, status and exception counts, 409/410 rates, SSE reconnects
by reason, event lag (POST start → `update` arriving at other
subscribers), and the least-squares RSS slope over the hold phase. Exit
code 3 when that slope exceeds `--threshold` (MB/min, default 2).

`/-/paper/api/debug/instances` is polled as `root` and recorded when it
exists; a 404 just turns the poll off.

## Bench self-check

The bench samples its own CPU (psutil) and event-loop lag (drift of a
100 ms `asyncio.sleep`) alongside the server. If more than 10 % of
samples exceed 70 % CPU or 50 ms lag, the summary prints a loud WARNING
and `summary.bench_self.latency_trustworthy` is `false`: every latency
number in that run includes client-side queueing and must not be read as
server time. The `[bench] t=…` progress lines show `self_cpu` and
`loop_lag` live so you can catch it early. The per-step doc model is
O(edit) (string-sliced token region + bisect over cumulative paragraph
offsets), which keeps one process fine up to ~20-30 users on 300 KB
docs; beyond that use `--workers N` (users split round-robin across N
processes, each with its own self-check, metrics merged at the end —
`--workers 4` for 100 users). Event lag is only measured between users
in the same worker.
