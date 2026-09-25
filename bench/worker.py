"""``--workers`` process entry point.

Lives in its own importable module (not ``bench/__main__.py``) because the
``spawn`` start method pickles the target by qualified name and cannot
re-import ``__main__`` when the bench was started with ``python -m bench``.
"""

from __future__ import annotations

import asyncio

from .metrics import Metrics
from .runner import progress, run_users, self_probe


async def _worker_async(w: dict) -> Metrics:
    m = Metrics(t0=w["t0"])
    stop = asyncio.Event()
    user_tasks: list[asyncio.Task] = []
    aux = [
        asyncio.create_task(self_probe(m, stop, w["sample_interval"])),
        asyncio.create_task(progress(m, user_tasks, stop, tag=f" w{w['index']}")),
    ]
    try:
        await run_users(
            w["schedule"],
            w["end_at"],
            w["base_url"],
            w["secret"],
            w["pool"],
            w["behaviour"],
            w["seed"],
            m,
            stop,
            user_tasks,
        )
    finally:
        stop.set()
        for t in user_tasks:
            t.cancel()
        await asyncio.gather(*user_tasks, return_exceptions=True)
        for t in aux:
            t.cancel()
        await asyncio.gather(*aux, return_exceptions=True)
    return m


def worker_main(w: dict, q) -> None:
    """Run a slice of users in this process and ship the metrics back."""
    try:
        m = asyncio.run(_worker_async(w))
        q.put((w["index"], m))
    except KeyboardInterrupt:
        pass
    except Exception as exc:  # report, don't hang the parent
        q.put((w["index"], exc))
