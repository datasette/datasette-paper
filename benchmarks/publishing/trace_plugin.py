"""Datasette plugin: count SQLite statements + expose the counter.

Loaded via ``--plugins-dir`` for the benchmark only. Every prepared connection
gets a trace callback that increments a process-global counter; the harness
reads ``/-/bench/qcount`` before and after a scenario batch to get
"SQLite statements executed per page view" — the cleanest scaling signal for
comparing the published (1 read) vs live-editor (N× queries) paths.
"""

import threading

from datasette import Response, hookimpl

_LOCK = threading.Lock()
_COUNT = {"n": 0}


@hookimpl
def prepare_connection(conn):
    def _trace(_sql):
        with _LOCK:
            _COUNT["n"] += 1

    conn.set_trace_callback(_trace)


@hookimpl
def register_routes():
    async def qcount(request):
        with _LOCK:
            n = _COUNT["n"]
        return Response.json({"count": n})

    return [(r"^/-/bench/qcount$", qcount)]
