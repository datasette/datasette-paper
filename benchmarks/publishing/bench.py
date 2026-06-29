#!/usr/bin/env python
"""Publishing benchmark harness — prerendered-published vs live-editor fan-out.

Self-contained (mirrors frontend/scripts/screenshots.mjs): boots a throwaway
Datasette with a seeded data DB + the query-counter plugin, seeds a doc with K
data blocks, publishes it both **all-frozen** and **all-live**, then drives a
concurrency matrix of HTTP scenarios with asyncio + httpx and writes a markdown
report. No external load tool required (k6 scripts in ./k6 are an alternative).

Scenarios (same doc/data, different serving path) — see plans/publishing/06:
  A  status-quo   editor bootstrap (GET page + GET /document) + K data XHRs
  B  frozen       GET …/publish — one cheap read, zero data XHRs
  C  live         GET …/publish (static) + K data XHRs (hydrator's per-viewer fetches)
  (D — public+CDN — needs a caching proxy; out of scope for the local harness.)

Run:  uv run --prerelease=allow python benchmarks/publishing/bench.py
      [--vus 1,10,50] [--iterations 40] [--blocks 5] [--rows 5000]

Defaults keep a full run to a few seconds. Scale --vus toward 1000 (and add a
reverse-proxy cache for D) to reproduce the headline numbers in the plan.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import socket
import statistics
import subprocess
import sys
import time
from pathlib import Path

import httpx

try:
    import psutil  # optional — server CPU/RSS sampling degrades gracefully
except Exception:  # pragma: no cover - psutil is not a hard dep
    psutil = None

HERE = Path(__file__).resolve().parent
WORK = Path("/tmp/datasette-paper-bench")
INTERNAL_DB = WORK / "internal.db"
DATA_DIR = WORK / "data"
DATA_DB = DATA_DIR / "data.db"
RESULTS = HERE / "results"
SECRET = "bench-secret-not-for-prod"
PORT = int(os.environ.get("BENCH_PORT", "8487"))
BASE = f"http://localhost:{PORT}"
ACTOR = "alice"


def sign_actor(actor_id: str) -> str:
    from itsdangerous import URLSafeSerializer

    return URLSafeSerializer(SECRET).dumps({"a": {"id": actor_id}}, salt="actor")


def seed_data_db(rows: int) -> None:
    import sqlite3

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if DATA_DB.exists():
        DATA_DB.unlink()
    db = sqlite3.connect(DATA_DB)
    db.execute("create table events (id integer primary key, kind text, n integer)")
    db.executemany(
        "insert into events (id, kind, n) values (?, ?, ?)",
        [(i, f"kind-{i % 7}", i * 3) for i in range(1, rows + 1)],
    )
    db.commit()
    db.close()


def free_port_or_die() -> None:
    s = socket.socket()
    try:
        s.bind(("localhost", PORT))
    except OSError:
        sys.exit(f"port {PORT} is busy; set BENCH_PORT and retry")
    finally:
        s.close()


def boot_datasette() -> subprocess.Popen:
    WORK.mkdir(parents=True, exist_ok=True)
    if INTERNAL_DB.exists():
        INTERNAL_DB.unlink()
    return subprocess.Popen(
        [
            "uv",
            "run",
            "--prerelease=allow",
            "datasette",
            "--internal",
            str(INTERNAL_DB),
            str(DATA_DB),
            "--secret",
            SECRET,
            "--plugins-dir",
            str(HERE),
            "-s",
            "permissions.datasette-paper-create",
            "true",
            # Scenario A models read-only viewers on the live editor, so they
            # need paper-view (the published page B/C gates separately on its
            # own audience, so this doesn't shortcut them).
            "-s",
            "permissions.paper-view",
            "true",
            "-p",
            str(PORT),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


async def wait_ready(client: httpx.AsyncClient, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = await client.get(f"{BASE}/-/paper/", timeout=2.0)
            if r.status_code < 500:
                return
        except Exception:
            pass
        await asyncio.sleep(0.25)
    raise RuntimeError("datasette did not become ready")


# K data blocks against the seeded `data` db; one query each.
def doc_markdown(blocks: int) -> str:
    parts = ["# Benchmark report", "", "Prose paragraph for the prerender path.", ""]
    for i in range(blocks):
        parts += [
            "```sql db=data",
            f"select id, kind, n from events limit {20 + i}",
            "```",
            "",
        ]
    return "\n".join(parts)


async def seed_docs(client: httpx.AsyncClient, blocks: int) -> dict:
    cookie = {"ds_actor": sign_actor(ACTOR)}
    md = doc_markdown(blocks)

    async def make_and_publish(mode: str) -> int:
        r = await client.post(
            f"{BASE}/-/paper/api/docs",
            json={"name": f"bench-{mode}", "content": md},
            cookies=cookie,
        )
        r.raise_for_status()
        doc_id = r.json()["id"]
        r = await client.post(
            f"{BASE}/-/paper/api/docs/{doc_id}/publish",
            json={"data_mode_default": mode, "audience": [{"principal": "everyone"}]},
            cookies=cookie,
        )
        r.raise_for_status()
        return doc_id

    frozen_id = await make_and_publish("frozen")
    live_id = await make_and_publish("live")
    # The query each data block runs (the live hydrator's per-viewer fetch).
    queries = [f"select id, kind, n from events limit {20 + i}" for i in range(blocks)]
    return {"frozen": frozen_id, "live": live_id, "queries": queries}


# --- scenarios: each returns a coroutine performing ONE "viewer" iteration ----
def scenario_b(client, ids):
    async def run():
        r = await client.get(f"{BASE}/-/paper/doc/{ids['frozen']}/publish")
        r.raise_for_status()

    return run


def scenario_c(client, ids):
    async def run():
        r = await client.get(f"{BASE}/-/paper/doc/{ids['live']}/publish")
        r.raise_for_status()
        for sql in ids["queries"]:
            rr = await client.get(
                f"{BASE}/data/-/query.json",
                params={"sql": sql, "_shape": "arrays", "_extra": "columns"},
            )
            rr.raise_for_status()

    return run


def scenario_a(client, ids):
    async def run():
        # Editor page + bootstrap document, then the same K data XHRs. (SSE hold
        # is omitted; the per-viewer DB cost is the dominant scaling term.)
        r = await client.get(f"{BASE}/-/paper/doc/{ids['live']}")
        r.raise_for_status()
        r = await client.get(f"{BASE}/-/paper/api/docs/{ids['live']}/document")
        r.raise_for_status()
        for sql in ids["queries"]:
            rr = await client.get(
                f"{BASE}/data/-/query.json",
                params={"sql": sql, "_shape": "arrays", "_extra": "columns"},
            )
            rr.raise_for_status()

    return run


async def qcount(client) -> int:
    r = await client.get(f"{BASE}/-/bench/qcount")
    return r.json()["count"]


async def run_scenario(client, make_iter, *, vus: int, iterations: int, proc):
    """Run `iterations` viewer-iterations with `vus` concurrent at a time."""
    sem = asyncio.Semaphore(vus)
    latencies: list[float] = []

    async def one():
        async with sem:
            t0 = time.monotonic()
            await make_iter()()
            latencies.append((time.monotonic() - t0) * 1000)

    # psutil CPU sampling across the batch.
    ps = psutil.Process(proc.pid) if psutil else None
    if ps:
        ps.cpu_percent(None)  # prime
    q0 = await qcount(client)
    rss0 = ps.memory_info().rss if ps else 0
    t0 = time.monotonic()
    await asyncio.gather(*(one() for _ in range(iterations)))
    wall = time.monotonic() - t0
    q1 = await qcount(client)
    cpu = ps.cpu_percent(None) if ps else None
    rss = ps.memory_info().rss if ps else 0

    latencies.sort()

    def pct(p):
        if not latencies:
            return 0.0
        k = min(len(latencies) - 1, int(round(p / 100 * (len(latencies) - 1))))
        return latencies[k]

    return {
        "vus": vus,
        "iterations": iterations,
        "p50": pct(50),
        "p95": pct(95),
        "p99": pct(99),
        "mean": statistics.fmean(latencies) if latencies else 0.0,
        "rps": iterations / wall if wall else 0.0,
        "queries_per_view": (q1 - q0) / iterations if iterations else 0.0,
        "cpu_pct": cpu,
        "rss_mb": rss / 1e6 if rss else (rss0 / 1e6 if rss0 else 0.0),
    }


def write_report(cfg, rows):
    RESULTS.mkdir(parents=True, exist_ok=True)
    out = RESULTS / "report.md"
    lines = [
        "# Publishing benchmark report",
        "",
        f"- blocks (K): {cfg['blocks']} · data rows (R): {cfg['rows']} · "
        f"iterations: {cfg['iterations']}",
        f"- psutil: {'yes' if psutil else 'no (CPU/RSS omitted)'}",
        "",
        "Scenarios: **A** live editor (bootstrap + K XHRs) · **B** frozen "
        "(1 read) · **C** live published (static + K XHRs).",
        "",
        "| scenario | VUs | p50 ms | p95 ms | p99 ms | req/s | queries/view | CPU% | RSS MB |",
        "|---|--:|--:|--:|--:|--:|--:|--:|--:|",
    ]
    for name, r in rows:
        cpu = "—" if r["cpu_pct"] is None else f"{r['cpu_pct']:.0f}"
        lines.append(
            f"| {name} | {r['vus']} | {r['p50']:.1f} | {r['p95']:.1f} | "
            f"{r['p99']:.1f} | {r['rps']:.0f} | {r['queries_per_view']:.1f} | "
            f"{cpu} | {r['rss_mb']:.0f} |"
        )
    lines += [
        "",
        "Read it as: **B** should stay ~flat with VUs and ~1 query/view; **C** "
        "drops the editor bootstrap/SSE cost but still scales queries/view with "
        "K; **A** is the most expensive per view. Push --vus toward 1000 to find "
        "where A's p95 crosses 1s (the 'why publish' number).",
        "",
    ]
    out.write_text("\n".join(lines))
    return out


async def main_async(cfg):
    free_port_or_die()
    seed_data_db(cfg["rows"])
    proc = boot_datasette()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            await wait_ready(client)
            ids = await seed_docs(client, cfg["blocks"])
            scenarios = [
                ("A live-editor", scenario_a),
                ("B frozen", scenario_b),
                ("C live", scenario_c),
            ]
            rows = []
            for name, factory in scenarios:
                for vus in cfg["vus"]:
                    res = await run_scenario(
                        client,
                        lambda f=factory: f(client, ids),
                        vus=vus,
                        iterations=cfg["iterations"],
                        proc=proc,
                    )
                    rows.append((name, res))
                    print(
                        f"{name:14s} vus={vus:<4d} p95={res['p95']:6.1f}ms "
                        f"rps={res['rps']:7.0f} q/view={res['queries_per_view']:.1f}"
                    )
            report = write_report(cfg, rows)
            print(f"\nreport → {report}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(WORK, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--vus", default="1,10,50", help="comma-separated concurrency levels"
    )
    ap.add_argument("--iterations", type=int, default=40)
    ap.add_argument("--blocks", type=int, default=5)
    ap.add_argument("--rows", type=int, default=5000)
    args = ap.parse_args()
    cfg = {
        "vus": [int(v) for v in args.vus.split(",") if v.strip()],
        "iterations": args.iterations,
        "blocks": args.blocks,
        "rows": args.rows,
    }
    asyncio.run(main_async(cfg))


if __name__ == "__main__":
    main()
