"""Root-only introspection of the in-memory collab layer.

``GET /-/paper/api/debug/instances`` reports, for every hot ``Instance``, the
state that can grow without bound (subscriber queues, step tail, presence,
cached live doc), plus the process-wide prosemirror-py resolve cache and RSS.
Gated on Datasette's ``permissions-debug`` action, the same gate core uses for
``/-/threads.json``; only root holds it unless config grants it.
"""

import os
import sys
from typing import Optional

from datasette import Response
from prosemirror.model import resolvedpos

from ..instance import Instance, get_registry
from ..router import router


def _rss_bytes() -> Optional[int]:
    """Current resident set size (Linux only; ``None`` elsewhere)."""
    try:
        with open("/proc/self/statm") as f:
            pages = int(f.read().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError, AttributeError):
        return None


def _peak_rss_bytes() -> Optional[int]:
    try:
        import resource
    except ImportError:  # Windows
        return None
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # Linux reports kilobytes, macOS bytes.
    return peak if sys.platform == "darwin" else peak * 1024


def _instance_report(inst: Instance) -> dict:
    cached = inst._cached_live_doc_json
    return {
        "doc_id": inst.doc_id,
        "version": inst.version,
        "subscribers": len(inst.subscribers),
        "queue_sizes": [q.qsize() for q in list(inst.subscribers)],
        "steps_tail": len(inst.steps_tail),
        "presence": len(inst.presence),
        "is_pinned": inst.is_pinned,
        "cached_doc_bytes": len(cached.encode("utf-8")) if cached else 0,
    }


@router.GET(r"^/-/paper/api/debug/instances$")
async def debug_instances(datasette, request):
    await datasette.ensure_permission(action="permissions-debug", actor=request.actor)
    registry = get_registry(datasette)
    return Response.json(
        {
            "instances": [
                _instance_report(inst) for inst in list(registry._instances.values())
            ],
            "resolve_cache_entries": len(resolvedpos._resolve_cache),
            "rss_bytes": _rss_bytes(),
            "peak_rss_bytes": _peak_rss_bytes(),
        }
    )
