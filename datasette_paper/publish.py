"""Build a publication: materialize a doc version, resolve identity labels,
and render it to static HTML via ``html_render``.

Separated from the route handlers so the rendering pipeline is unit-testable
without HTTP and so the frozen-data executor (T05) has a clean seam to plug
into. The route layer (``routes/publish.py``) owns persistence, ACL audience
grants, cache headers, and SSE broadcast.
"""

from __future__ import annotations

import json
from typing import Awaitable, Callable, Optional

from .html_render import Labels, render_doc
from .instance import materialize_doc_at
from .util import resolve_actor_profiles

# A frozen-block executor: given a DataBlock, return its baked payload dict
# (``{columns, rows, ...}`` / ``{text}`` / provider payload) computed with the
# publisher's permissions, or ``None`` to fall back to live. Wired in T05;
# ``None`` here means "publish all-live".
FrozenExecutor = Callable[[object], Awaitable[Optional[dict]]]


def _collect_ref_ids(doc: dict) -> tuple[set, set]:
    """Walk a doc, returning ``(actor_ids, paper_doc_ids)`` referenced by
    ``mention`` / ``paper_link`` inline atoms (for label resolution)."""
    actor_ids: set = set()
    paper_ids: set = set()

    def walk(node):
        t = node.get("type")
        if t == "mention":
            aid = (node.get("attrs") or {}).get("actorId")
            if aid:
                actor_ids.add(str(aid))
        elif t == "paper_link":
            did = (node.get("attrs") or {}).get("docId")
            if did is not None:
                paper_ids.add(int(did))
        for child in node.get("content") or []:
            walk(child)

    walk(doc)
    return actor_ids, paper_ids


async def resolve_labels(datasette, db, doc: dict) -> Labels:
    """Resolve mention names + paper-link titles for a doc, server-side.

    Inline-embed labels are left to the client hydrator (they're per-viewer
    permission-sensitive), so :class:`Labels` falls back to the raw ref for
    those.
    """
    actor_ids, paper_ids = _collect_ref_ids(doc)

    profiles = await resolve_actor_profiles(datasette, actor_ids) if actor_ids else {}
    actor_names = {aid: (p or {}).get("name") for aid, p in profiles.items()}

    paper_info: dict[int, dict] = {}
    for did in paper_ids:
        row = await db.select_doc_by_id(did)
        if row is None:
            paper_info[did] = {
                "title": f"Paper {did}",
                "href": f"/-/paper/doc/{did}",
                "state": "missing",
            }
        else:
            paper_info[did] = {
                "title": row.name or f"Paper {did}",
                "href": f"/-/paper/doc/{did}",
                "state": row.state,
            }

    return Labels(
        actor=lambda aid: actor_names.get(str(aid)),
        paper=lambda did: paper_info.get(int(did)),
    )


async def build_publication(
    datasette,
    db,
    *,
    doc_id: int,
    version: int,
    data_mode_default: str = "live",
    block_overrides: Optional[dict] = None,
    published_by: Optional[str] = None,
    frozen_executor: Optional[FrozenExecutor] = None,
) -> dict:
    """Materialize doc@version and render it to a publication payload.

    Returns ``{html, doc_json, has_live_blocks, config_json, frozen_data,
    warnings}`` ready for ``PaperDB.write_publication``. Two-pass: render once
    all-live to discover the data blocks + their ids, resolve each block's mode,
    run the frozen executor for frozen blocks, then render again with the final
    modes + baked payloads.

    With ``frozen_executor=None`` (the pre-T05 path) every block stays live.
    """
    block_overrides = block_overrides or {}
    doc_json = await materialize_doc_at(db, doc_id, version)
    labels = await resolve_labels(datasette, db, doc_json)

    # Pass 1 — discover data blocks (ids assigned in document order).
    discovery = render_doc(doc_json, labels=labels)

    def requested_mode(block_id: str) -> str:
        return block_overrides.get(block_id, data_mode_default)

    warnings: list[dict] = []
    payloads: dict[str, dict] = {}
    frozen_data: list[dict] = []
    final_mode: dict[str, str] = {}

    for block in discovery.blocks:
        want = requested_mode(block.block_id)
        if want == "frozen" and frozen_executor is not None:
            payload = await frozen_executor(block)
            if payload is None:
                # Executor declined (e.g. custom embed w/o precompute hook) —
                # fall back to live and tell the publisher.
                warnings.append(
                    {"block_id": block.block_id, "reason": "could not precompute"}
                )
                final_mode[block.block_id] = "live"
            else:
                final_mode[block.block_id] = "frozen"
                payloads[block.block_id] = payload
                frozen_data.append(
                    {
                        "block_id": block.block_id,
                        "kind": block.kind,
                        "payload_json": json.dumps(payload),
                        "computed_by": published_by,
                    }
                )
        else:
            final_mode[block.block_id] = "live"

    # Pass 2 — render with resolved modes + baked payloads.
    result = render_doc(
        doc_json,
        labels=labels,
        mode_for=lambda bid: final_mode.get(bid, "live"),
        payloads=payloads,
    )

    config = {
        "data_mode_default": data_mode_default,
        "block_overrides": block_overrides,
    }
    return {
        "html": result.html,
        "doc_json": json.dumps(doc_json),
        "has_live_blocks": result.has_live_blocks,
        "config_json": json.dumps(config),
        "frozen_data": frozen_data,
        "warnings": warnings,
        "blocks": [
            {"block_id": b.block_id, "kind": b.kind, "mode": final_mode[b.block_id]}
            for b in discovery.blocks
        ],
    }
