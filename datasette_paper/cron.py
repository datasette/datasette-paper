"""Background sweeps for datasette-paper.

Currently exposes one sweep — :func:`sweep_trashed`, which hard-deletes
papers whose ``delete_at`` has passed. This isn't wired to a schedule
yet; it's a plain async function so tests can call it directly. The
production hookup will come from datasette-cron — see the TODO below.
"""

from __future__ import annotations

import datetime
import logging

from .instance import get_registry
from .util import paper_db


logger = logging.getLogger(__name__)


def _iso_now() -> str:
    now = datetime.datetime.now(datetime.timezone.utc)
    return (
        now.strftime("%Y-%m-%dT%H:%M:")
        + f"{now.second:02d}.{now.microsecond // 1000:03d}Z"
    )


async def sweep_trashed(datasette) -> int:
    """Hard-delete trashed papers whose ``delete_at`` has passed.

    Returns the number of papers deleted. Cascade in the schema removes
    each paper's steps, snapshots, and shares; the in-memory ``Instance``
    (if any) is evicted from the registry and any open SSE subscribers
    receive a ``closed`` sentinel so they disconnect cleanly.

    TODO: wire this to datasette-cron once that plugin is installed.
    Recommended cadence: every 15 minutes — the retention window is
    multi-day so precise timing isn't critical, and the sweep itself is
    cheap (an indexed range scan + a handful of DELETEs).
    """
    db = paper_db(datasette)
    rows = await db.list_trashed_to_delete(now=_iso_now())
    if not rows:
        return 0

    registry = get_registry(datasette)
    deleted = 0
    for row in rows:
        instance = registry._instances.pop(row.id, None)
        if instance is not None:
            # Same sentinel ``revoke_unauthorized`` uses — the SSE loop
            # exits cleanly and clients see EventSource close.
            for q in list(instance.subscribers):
                q.put_nowait({"kind": "closed"})
            instance.subscribers.clear()
        await db.hard_delete_doc(doc_id=row.id)
        deleted += 1

    logger.info("datasette-paper: cron swept %d trashed paper(s)", deleted)
    return deleted
