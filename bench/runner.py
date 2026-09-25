"""Per-process pieces of the bench: user scheduling and the self-probe.

Shared by the in-process path (``--workers 1``) and ``bench.worker``.
"""

from __future__ import annotations

import asyncio
import random
import time

import psutil

from .metrics import Metrics
from .server import sign_actor_cookie
from .user import Behaviour, SimUser


async def self_probe(m: Metrics, stop: asyncio.Event, interval: float) -> None:
    """Every process that runs users: own CPU % and worst asyncio sleep drift.

    A 100 ms sleep that wakes 300 ms late means 200 ms of other coroutines
    ran back to back — every HTTP timing in that window is inflated by our
    own event loop, not by the server.
    """
    me = psutil.Process()
    me.cpu_percent(interval=None)  # prime
    worst = 0.0
    last_flush = time.monotonic()
    while not stop.is_set():
        t0 = time.monotonic()
        await asyncio.sleep(0.1)
        worst = max(worst, time.monotonic() - t0 - 0.1)
        if time.monotonic() - last_flush >= interval:
            t = m.now()
            m.loop_lag.append((t, worst))
            m.bench_cpu.append((t, me.cpu_percent(interval=None)))
            worst = 0.0
            last_flush = time.monotonic()


async def progress(m: Metrics, users: list, stop: asyncio.Event, tag: str = "") -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), 10.0)
        except asyncio.TimeoutError:
            pass
        rss = f"{m.rss[-1][1] / 2**20:.0f} MB" if m.rss else "n/a"
        ev = m.status.get("events", {})
        posts = sum(ev.values())
        lag = sorted(m.event_lag[-200:])
        lag_p50 = f"{lag[len(lag) // 2] * 1000:.0f} ms" if lag else "n/a"
        self_cpu = f"{m.bench_cpu[-1][1]:.0f}%" if m.bench_cpu else "n/a"
        lag_ms = f"{m.loop_lag[-1][1] * 1000:.0f}ms" if m.loop_lag else "n/a"
        print(
            f"[bench{tag}] t={m.now():6.0f}s "
            f"users={sum(1 for u in users if not u.done()):3d} "
            f"self_cpu={self_cpu} loop_lag={lag_ms} "
            f"rss={rss:>8} events={posts} 409={ev.get(409, 0)} "
            f"steps_sent={m.steps_sent} lag_p50={lag_p50} "
            f"reconnects={sum(m.reconnects.values())}",
            flush=True,
        )


# -- user runners ---------------------------------------------------------------


async def run_users(
    schedule: list[tuple[int, str, float]],  # (uid, role, start_at_monotonic)
    end_at: float,  # monotonic
    base_url: str,
    secret: str,
    pool: list[int],
    behaviour: Behaviour,
    seed: int,
    m: Metrics,
    stop: asyncio.Event,
    user_tasks: list[asyncio.Task],
) -> None:
    """Start each user at its scheduled time; return at ``end_at``."""
    for uid, role, start_at in schedule:
        delay = start_at - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
        if stop.is_set():
            return
        u = SimUser(
            uid=uid,
            role=role,
            base_url=base_url,
            cookie=sign_actor_cookie(f"bench-user-{uid}", secret),
            doc_pool=pool,
            metrics=m,
            rng=random.Random(seed * 1000 + uid),
            behaviour=behaviour,
            stop=stop,
        )
        user_tasks.append(asyncio.create_task(u.run()))
    remaining = end_at - time.monotonic()
    if remaining > 0:
        try:
            await asyncio.wait_for(stop.wait(), remaining)
        except asyncio.TimeoutError:
            pass
