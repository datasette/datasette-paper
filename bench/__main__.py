"""Load benchmarker for datasette-paper: ~100 humans on a few shared docs.

    uv run --prerelease=allow --group bench python -m bench --serve \\
        --users 100 --ramp 5m --hold 10m --docs 8 --doc-kb 300 --workers 4

Either ``--serve`` (spawn datasette from ``--repo-path``, default: this
repo) or ``--url`` (an already-running server that grants
``paper-view`` / ``paper-edit`` / ``datasette-paper-create`` globally and
uses ``--secret`` for cookies). Writes ``<out>.json`` + a text summary;
``--compare a.json b.json`` diffs two result files.

Phases: ``setup`` (seed docs) → ``ramp`` (start users evenly over
``--ramp``) → ``hold`` (steady state; the RSS slope is measured here) →
``teardown``. Pass/fail is the hold-phase RSS slope vs ``--threshold``.

``--workers N`` splits the users round-robin across N processes so the
bench's own event loop never becomes the bottleneck (the summary's
self-check says when it has). Each worker keeps its own metrics; they are
merged at the end. Event lag is only observed between users in the same
worker, which round-robin assignment keeps plentiful.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import multiprocessing as mp
import random
import sys
import time
from pathlib import Path

import httpx2 as httpx

from .docmodel import seed_markdown
from .metrics import Metrics, format_compare, format_summary
from .server import SECRET, Server, sign_actor_cookie
from .runner import progress, run_users, self_probe
from .user import Behaviour
from .worker import worker_main

REPO = Path(__file__).resolve().parent.parent
DEBUG_INSTANCES = "/-/paper/api/debug/instances"


def parse_duration(s: str) -> float:
    s = s.strip().lower()
    mult = {"s": 1, "m": 60, "h": 3600}
    if s and s[-1] in mult:
        return float(s[:-1]) * mult[s[-1]]
    return float(s)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="bench", description=__doc__.split("\n\n")[0])
    p.add_argument("--url", help="benchmark an already-running server")
    p.add_argument("--serve", action="store_true", help="spawn datasette + plugin")
    p.add_argument(
        "--repo-path",
        type=Path,
        default=REPO,
        help="checkout to serve (with --serve)",
    )
    p.add_argument("--port", type=int, help="port for --serve (default: free port)")
    p.add_argument(
        "--secret", default=SECRET, help="DATASETTE_SECRET of the --url server"
    )
    p.add_argument("--users", type=int, default=100)
    p.add_argument("--ramp", default="5m", help="ramp-up duration, e.g. 90s / 5m")
    p.add_argument("--hold", default="10m", help="steady-state duration")
    p.add_argument("--docs", type=int, default=8, help="shared docs to seed")
    p.add_argument(
        "--doc-kb", type=int, default=300, help="seed size of each shared doc"
    )
    p.add_argument(
        "--readers", type=float, default=0.2, help="fraction of users that only read"
    )
    p.add_argument(
        "--creators",
        type=float,
        default=0.05,
        help="fraction that create/delete docs",
    )
    p.add_argument(
        "--think-scale",
        type=float,
        default=1.0,
        help="multiply think time (>1 = calmer)",
    )
    p.add_argument("--reload-min", default="60s")
    p.add_argument("--reload-max", default="240s")
    p.add_argument(
        "--stall-prob",
        type=float,
        default=0.3,
        help="reloads that leave the old socket open",
    )
    p.add_argument(
        "--workers",
        type=int,
        default=1,
        help="processes to spread users over (1 = in-process)",
    )
    p.add_argument(
        "--sample-interval", type=float, default=2.0, help="RSS sample period (s)"
    )
    p.add_argument(
        "--threshold",
        type=float,
        default=2.0,
        help="max OK hold-phase RSS slope, MB/min",
    )
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--label", default="", help="free-text label stored in the result")
    p.add_argument(
        "--out", type=Path, help="result JSON path (default bench/results/<ts>.json)"
    )
    p.add_argument(
        "--workdir", type=Path, help="server log/db dir (default next to --out)"
    )
    p.add_argument("--compare", nargs=2, metavar=("A.json", "B.json"))
    return p


async def seed_docs(
    base_url: str, secret: str, n: int, kb: int, rng: random.Random, m: Metrics
) -> list[int]:
    cookie = sign_actor_cookie("bench-seed", secret)
    ids: list[int] = []
    async with httpx.AsyncClient(
        base_url=base_url, cookies={"ds_actor": cookie}, timeout=120.0
    ) as c:
        for i in range(n):
            t = time.monotonic()
            r = await c.post(
                "/-/paper/api/docs",
                json={
                    "name": f"bench doc {i}",
                    "content": seed_markdown(kb * 1024, rng),
                },
            )
            m.record("create", r.status_code, time.monotonic() - t)
            if r.status_code != 201:
                raise RuntimeError(
                    f"seed create failed: {r.status_code} {r.text[:200]}"
                )
            ids.append(r.json()["id"])
    return ids


# -- probes -------------------------------------------------------------------


async def server_sampler(
    server: Server | None,
    base_url: str,
    secret: str,
    m: Metrics,
    interval: float,
    stop: asyncio.Event,
) -> None:
    """Main process only: server RSS/CPU + the optional debug route."""
    debug_ok = True
    cookie = sign_actor_cookie("root", secret)
    async with httpx.AsyncClient(
        base_url=base_url, cookies={"ds_actor": cookie}, timeout=10.0
    ) as c:
        while not stop.is_set():
            t = m.now()
            if server is not None:
                s = server.sample()
                if s is not None:
                    m.rss.append((t, s[0]))
                    m.cpu.append((t, s[1]))
            if debug_ok:
                try:
                    r = await c.get(DEBUG_INSTANCES)
                    if r.status_code == 404:
                        debug_ok = False
                    elif r.status_code == 200:
                        m.debug_instances.append((t, r.json()))
                except (httpx.HTTPError, ValueError):
                    pass
            try:
                await asyncio.wait_for(stop.wait(), interval)
            except asyncio.TimeoutError:
                pass


def assign_roles(args, rng: random.Random) -> list[str]:
    n_creators = round(args.users * args.creators)
    n_readers = round(args.users * args.readers)
    roles = ["creator"] * n_creators + ["reader"] * n_readers
    roles += ["editor"] * (args.users - len(roles))
    rng.shuffle(roles)
    return roles


# -- main ----------------------------------------------------------------------


async def run(args) -> int:
    rng = random.Random(args.seed)
    m = Metrics()
    ramp = parse_duration(args.ramp)
    hold = parse_duration(args.hold)
    ts = time.strftime("%Y%m%d-%H%M%S")
    out = args.out or (REPO / "bench" / "results" / f"{ts}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    workdir = args.workdir or out.with_suffix("")
    workdir.mkdir(parents=True, exist_ok=True)

    server: Server | None = None
    if args.serve:
        server = Server(args.repo_path, workdir, port=args.port)
        server.start()
        base_url = server.url
        secret = SECRET
    elif args.url:
        base_url = args.url.rstrip("/")
        secret = args.secret
    else:
        print("need --serve or --url", file=sys.stderr)
        return 2

    behaviour = Behaviour(
        think_scale=args.think_scale,
        reload_min=parse_duration(args.reload_min),
        reload_max=parse_duration(args.reload_max),
        stall_prob=args.stall_prob,
    )
    stop = asyncio.Event()
    user_tasks: list[asyncio.Task] = []
    aux: list[asyncio.Task] = []
    workers: list[mp.Process] = []
    worker_metrics: list[Metrics] = []
    rc = 1
    try:
        m.mark("setup")
        print(f"[bench] seeding {args.docs} docs of ~{args.doc_kb} KB", flush=True)
        pool = await seed_docs(base_url, secret, args.docs, args.doc_kb, rng, m)
        aux.append(
            asyncio.create_task(
                server_sampler(server, base_url, secret, m, args.sample_interval, stop)
            )
        )

        roles = assign_roles(args, rng)
        gap = ramp / max(args.users, 1)
        m.mark("ramp")
        ramp_t0 = time.monotonic()
        schedule = [(uid, role, ramp_t0 + uid * gap) for uid, role in enumerate(roles)]
        end_at = ramp_t0 + ramp + hold
        print(
            f"[bench] ramping {args.users} users over {ramp:.0f}s "
            f"({roles.count('editor')} editors, {roles.count('reader')} readers, "
            f"{roles.count('creator')} creators) in {args.workers} process(es)",
            flush=True,
        )
        common = {
            "t0": m.t0,
            "end_at": end_at,
            "base_url": base_url,
            "secret": secret,
            "pool": pool,
            "behaviour": behaviour,
            "seed": args.seed,
            "sample_interval": args.sample_interval,
        }
        if args.workers <= 1:
            aux.append(asyncio.create_task(self_probe(m, stop, args.sample_interval)))
            aux.append(asyncio.create_task(progress(m, user_tasks, stop)))
            runner = asyncio.create_task(
                run_users(
                    schedule,
                    end_at,
                    base_url,
                    secret,
                    pool,
                    behaviour,
                    args.seed,
                    m,
                    stop,
                    user_tasks,
                )
            )
            await asyncio.sleep(max(0.0, ramp_t0 + ramp - time.monotonic()))
            m.mark("hold")
            print(f"[bench] holding {hold:.0f}s", flush=True)
            await runner
        else:
            ctx = mp.get_context("spawn")
            q = ctx.Queue()
            for i in range(args.workers):
                w = dict(common, index=i, schedule=schedule[i :: args.workers])
                p = ctx.Process(target=worker_main, args=(w, q), daemon=True)
                p.start()
                workers.append(p)
            await asyncio.sleep(max(0.0, ramp_t0 + ramp - time.monotonic()))
            m.mark("hold")
            print(f"[bench] holding {hold:.0f}s", flush=True)
            await asyncio.sleep(max(0.0, end_at - time.monotonic()))
            # Collect each worker's metrics (they exit on their own at end_at).
            deadline = time.monotonic() + 60
            got = 0
            while got < len(workers) and time.monotonic() < deadline:
                try:
                    idx, payload = await asyncio.get_running_loop().run_in_executor(
                        None, q.get, True, 5
                    )
                except Exception:
                    continue
                got += 1
                if isinstance(payload, Metrics):
                    worker_metrics.append(payload)
                else:
                    print(f"[bench] worker {idx} failed: {payload!r}")
                    m.error("worker", payload)
            if got < len(workers):
                print(f"[bench] only {got}/{len(workers)} workers reported")
        m.mark("hold_end")
        rc = 0
    except KeyboardInterrupt:
        print("[bench] interrupted; summarising what we have")
        m.mark("hold_end")
    finally:
        m.mark("teardown")
        stop.set()
        for t in user_tasks:
            t.cancel()
        await asyncio.gather(*user_tasks, return_exceptions=True)
        for t in aux:
            t.cancel()
        await asyncio.gather(*aux, return_exceptions=True)
        for p in workers:
            p.join(timeout=10)
            if p.is_alive():
                p.terminate()
        if server is not None:
            server.stop()

    for wm in worker_metrics:
        m.merge(wm)
    summary = m.summary(args.threshold)
    result = {
        "label": args.label,
        "timestamp": ts,
        "config": {
            k: (str(v) if isinstance(v, Path) else v)
            for k, v in vars(args).items()
            if k != "compare"
        },
        "server": {
            "url": base_url,
            "repo_path": str(args.repo_path) if args.serve else None,
            "log": str(server.log_path) if server else None,
            "log_issues": server.log_issues() if server else None,
        },
        "summary": summary,
        "series": m.raw(),
    }
    out.write_text(json.dumps(result, indent=1))
    text = format_summary(summary, args.label)
    if server is not None:
        text += f"\nserver log: {server.log_path} {result['server']['log_issues']}"
    out.with_suffix(".txt").write_text(text + "\n")
    print()
    print(text)
    print(f"\n[bench] wrote {out} and {out.with_suffix('.txt')}")
    if not summary["rss"]["hold_slope_ok"]:
        rc = 3
    return rc


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.compare:
        a, b = (json.loads(Path(p).read_text()) for p in args.compare)
        names = [Path(p).stem[-12:] for p in args.compare]
        print(
            format_compare(a, b, a.get("label") or names[0], b.get("label") or names[1])
        )
        return 0
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
