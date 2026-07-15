"""HTTP + SSE protocol client for paper docs — no textual imports.

The TUI is a network client of a running Datasette, never a direct reader of
the internal DB: all doc state flows through the per-doc ``Instance`` (write
lock, subscriber set, materialize cache) in the server process, so a second
writer would corrupt collab (see plans/tui/01-architecture.md).

``PaperClient`` wraps one ``httpx.AsyncClient`` (base URL + optional bearer
token) and exposes the doc-management endpoints. ``open_doc`` returns a
``DocSession`` that boots from the same bootstrap envelope the browser uses and
holds a live ``prosemirror.model.Node`` — materialized by replaying steps with
the package's own ``pm_schema`` (schema lock-step is inherited, not
re-declared). ``DocSession.events`` is a hand-rolled SSE reader; ``submit_replace``
generates a real collab ``ReplaceStep`` and POSTs it with the documented
409/410/400/422 version semantics.
"""

from __future__ import annotations

import asyncio
import json
import random
from dataclasses import dataclass
from typing import AsyncIterator, Optional

import httpx

from ..markdown import doc_to_markdown

# All paper routes are rooted here (no per-database segment).
API_ROOT = "/-/paper/api"


class PaperError(Exception):
    """Base class for protocol-level client errors."""


class ConflictError(PaperError):
    """409 — the submitted version is stale; catch up and retry."""


class GoneError(PaperError):
    """410 — history was evicted; the caller must re-bootstrap the doc."""


class InvalidStepError(PaperError):
    """422 (or a local apply failure) — the step doesn't fit the live doc."""


class BadVersionError(PaperError):
    """400 — the version is out of range for this doc."""


@dataclass
class SSEEvent:
    """One framed SSE event: ``kind`` is the wire event name / payload kind
    (``update`` / ``presence`` / ``state-changed`` / ``renamed`` /
    ``permissions-changed`` / ``closed``) and ``data`` the parsed JSON body."""

    kind: str
    data: dict


class PaperClient:
    """Async client over the paper HTTP API.

    ``base_url`` is the running server's root (default matches the ``tui`` CLI
    default). ``token`` becomes an ``Authorization: Bearer`` header on every
    request including the SSE GET. For in-process tests, pass ``transport`` (an
    ``httpx.ASGITransport``) and/or ``cookies`` (the fixtures sign a ``ds_actor``
    cookie) — either is enough to authenticate without a real token.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8001",
        token: Optional[str] = None,
        *,
        transport: Optional[httpx.BaseTransport] = None,
        cookies: Optional[dict] = None,
    ) -> None:
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        kwargs: dict = {"base_url": base_url.rstrip("/"), "headers": headers}
        if cookies:
            kwargs["cookies"] = cookies
        if transport is not None:
            kwargs["transport"] = transport
        self._http = httpx.AsyncClient(**kwargs)

    async def __aenter__(self) -> "PaperClient":
        return self

    async def __aexit__(self, *_exc) -> None:
        await self.close()

    async def close(self) -> None:
        await self._http.aclose()

    # --- doc management -----------------------------------------------------

    async def list_docs(
        self,
        state: str = "active",
        kind: str = "doc",
        tags: Optional[list] = None,
    ) -> list:
        params: list = [("state", state), ("kind", kind)]
        for t in tags or []:
            params.append(("tag", t))
        resp = await self._http.get(f"{API_ROOT}/docs", params=params)
        resp.raise_for_status()
        return resp.json()

    async def create(self, name: str) -> dict:
        resp = await self._http.post(f"{API_ROOT}/docs", json={"name": name})
        resp.raise_for_status()
        return resp.json()

    async def rename(self, doc_id: int, name: str) -> dict:
        resp = await self._http.post(
            f"{API_ROOT}/docs/{doc_id}/rename", json={"name": name}
        )
        resp.raise_for_status()
        return resp.json()

    async def append(self, doc_id: int, md: str) -> dict:
        resp = await self._http.post(
            f"{API_ROOT}/docs/{doc_id}/append", json={"content": md}
        )
        resp.raise_for_status()
        return resp.json()

    async def resolve_links(self, ids: list) -> dict:
        resp = await self._http.post(
            f"{API_ROOT}/links/resolve", json={"ids": list(ids)}
        )
        resp.raise_for_status()
        return resp.json().get("links", {})

    async def resolve_actors(self, ids: list) -> dict:
        resp = await self._http.post(
            f"{API_ROOT}/actors/resolve", json={"ids": list(ids)}
        )
        resp.raise_for_status()
        return resp.json().get("actors", {})

    async def get_document_markdown(self, doc_id: int) -> str:
        resp = await self._http.get(
            f"{API_ROOT}/docs/{doc_id}/document",
            headers={"Accept": "text/markdown"},
        )
        resp.raise_for_status()
        return resp.text

    async def open_doc(self, doc_id: int) -> "DocSession":
        resp = await self._http.get(f"{API_ROOT}/docs/{doc_id}")
        resp.raise_for_status()
        return DocSession(self, doc_id, resp.json())


def _child_index_range(doc, frm: int, to: int) -> set:
    """Top-level child indices whose position range overlaps ``[frm, to]``.

    Over-approximates on boundaries (an insertion between two blocks flags
    both) — safe, since the consumer only re-renders the returned blocks.
    """
    hits = set()
    offset = 0
    for i in range(doc.child_count):
        node = doc.child(i)
        start = offset
        end = offset + node.node_size
        if start <= to and end >= frm:
            hits.add(i)
        offset = end
    return hits


class DocSession:
    """A materialized, live view of one doc plus the write path.

    Boots from ``GET /api/docs/{id}`` and replays the bootstrap steps exactly
    like ``Instance.materialize_live_doc`` server-side. ``client_id`` is a random
    per-session collab clientID so the server can skip echoing our own POSTed
    steps back to us over SSE.
    """

    def __init__(self, client: PaperClient, doc_id: int, bootstrap: dict) -> None:
        # Late imports keep prosemirror off client.py's import cost until a doc
        # is actually opened (list-only sessions never pay it).
        from prosemirror.transform import Step

        from ..pm_schema import schema

        self._client = client
        self.doc_id = doc_id
        self.client_id = random.randint(0, 2**31 - 1)
        # Serializes doc mutation against the in-flight write: the SSE consumer
        # must hold this around apply_update so a foreign batch can't land
        # between submit_replace's POST and its local apply (which would be
        # silently clobbered by ``self.doc = result.doc``).
        self.lock = asyncio.Lock()
        self.permissions: dict = bootstrap.get("permissions") or {}
        self.version: int = bootstrap["version"]
        # Live subscriber count from the bootstrap envelope; the reader header
        # shows it and refreshes it from update/presence batches.
        self.users: int = bootstrap.get("users") or 0

        doc = schema.node_from_json(bootstrap["doc"])
        # Mirror the server materializer: apply steps in order, stop on the
        # first failure (leaves the doc as far as steps applied).
        for step_json in bootstrap.get("steps") or []:
            result = Step.from_json(schema, step_json).apply(doc)
            if result.failed:
                break
            doc = result.doc
        self.doc = doc

    @property
    def can_edit(self) -> bool:
        return bool(self.permissions.get("canEdit"))

    def block_count(self) -> int:
        return self.doc.child_count

    # @feat tui: per-block markdown via a single-node wrapper doc (reader view)
    def block_markdown(self, i: int) -> str:
        """Markdown for top-level block ``i`` — wraps the child as its own doc
        so ``doc_to_markdown`` (which requires a ``doc`` root) can serialize it.
        The ``resource_url`` resolver is skipped; refs stay as canonical
        ``paper:/`` hrefs."""
        child = self.doc.child(i)
        return doc_to_markdown({"type": "doc", "content": [child.to_json()]})

    # @feat tui: apply an SSE step batch to the live Node, report touched blocks
    def apply_update(self, batch: dict) -> set:
        """Apply an ``update`` batch's steps and return the set of top-level
        child indices it touched.

        Maps each step's ``[from, to]`` to overlapping child indices against the
        running doc. If the top-level child count changes (blocks added/removed)
        the mapped indices would be unstable, so we return every current index
        instead — "when unsure, return all"."""
        from prosemirror.transform import Step

        from ..pm_schema import schema

        doc = self.doc
        before_count = doc.child_count
        touched: set = set()
        unsure = False
        for step_json in batch.get("steps") or []:
            # Replace-family steps carry from/to; attr steps carry pos. Anything
            # else (unknown key shape) falls into the return-all path.
            if "from" in step_json:
                frm = step_json["from"]
                to = step_json.get("to", frm)
                touched |= _child_index_range(doc, frm, to)
            elif "pos" in step_json:
                touched |= _child_index_range(doc, step_json["pos"], step_json["pos"])
            else:
                unsure = True
            result = Step.from_json(schema, step_json).apply(doc)
            if result.failed:
                unsure = True
                break
            doc = result.doc

        self.doc = doc
        new_version = batch.get("version")
        if new_version is not None:
            self.version = new_version

        if unsure or doc.child_count != before_count:
            return set(range(doc.child_count))
        return touched

    # @feat tui: hand-rolled SSE reader — framing, heartbeats, reconnect, 410
    async def events(self, *, reconnect_delay: float = 0.5) -> AsyncIterator[SSEEvent]:
        """Async iterator over the doc's SSE stream.

        Connects at ``self.version`` with our ``client_id``; on a dropped
        connection or a clean EOF, reconnects at the current version (which the
        caller advances by feeding ``update`` events to ``apply_update``). A 410
        raises :class:`GoneError` so the caller re-bootstraps; a 403 (access
        revoked mid-session) yields a synthetic ``closed`` event and stops.
        """
        while True:
            params = {"version": self.version, "clientID": self.client_id}
            url = f"{API_ROOT}/docs/{self.doc_id}/events"
            try:
                async with self._client._http.stream("GET", url, params=params) as resp:
                    if resp.status_code == 410:
                        await resp.aread()
                        raise GoneError("History evicted; re-bootstrap required")
                    if resp.status_code == 400:
                        await resp.aread()
                        raise BadVersionError("Invalid SSE version")
                    if resp.status_code == 403:
                        await resp.aread()
                        yield SSEEvent("closed", {"kind": "closed"})
                        return
                    if resp.status_code != 200:
                        await resp.aread()
                        raise PaperError(f"SSE request failed: {resp.status_code}")
                    async for event in _read_sse(resp):
                        if event.kind == "closed":
                            yield event
                            return
                        yield event
            except (httpx.TransportError, httpx.RemoteProtocolError):
                # Connection dropped — reconnect at the current version.
                await asyncio.sleep(reconnect_delay)
                continue
            # Stream ended without error (server closed the response) — reconnect.
            await asyncio.sleep(reconnect_delay)

    # @feat tui: client-side ReplaceStep build + local verify + POST /events
    async def submit_replace(self, start: int, end: int, nodes: list) -> int:
        """Replace positions ``[start, end]`` with ``nodes`` (PM JSON dicts or
        Nodes) as one collab step.

        Builds a ``ReplaceStep``, verifies it applies to the local doc (refusing
        to send if not), then POSTs it at ``self.version``. On success the step
        is applied locally and the version advanced (the server skips echoing our
        own step back over SSE). 409/410/422/400 map to the typed client errors.
        """
        from prosemirror.model import Fragment, Node, Slice
        from prosemirror.transform import ReplaceStep

        from ..pm_schema import schema

        pm_nodes = [
            n if isinstance(n, Node) else Node.from_json(schema, n) for n in nodes
        ]
        async with self.lock:
            step = ReplaceStep(start, end, Slice(Fragment.from_array(pm_nodes), 0, 0))
            result = step.apply(self.doc)
            if result.failed:
                raise InvalidStepError(f"Step does not apply locally: {result.failed}")

            resp = await self._client._http.post(
                f"{API_ROOT}/docs/{self.doc_id}/events",
                json={
                    "version": self.version,
                    "clientID": self.client_id,
                    "steps": [step.to_json()],
                },
            )
            if resp.status_code == 409:
                raise ConflictError("Version not current")
            if resp.status_code == 410:
                raise GoneError("History gone")
            if resp.status_code == 400:
                raise BadVersionError("Invalid version")
            if resp.status_code == 422:
                body = resp.json()
                raise InvalidStepError(body.get("message") or "Invalid step")
            resp.raise_for_status()

            new_version = resp.json()["version"]
            self.doc = result.doc
            self.version = new_version
            return new_version


async def _read_sse(resp: httpx.Response) -> AsyncIterator[SSEEvent]:
    """Parse an ``event:`` / ``data:`` SSE stream into ``SSEEvent``s.

    Tolerant of ``:`` comment / heartbeat lines (skipped). A blank line
    dispatches the accumulated event; the payload's own ``kind`` field wins over
    the ``event:`` name (they match, but the kind is authoritative)."""
    event_name: Optional[str] = None
    data_lines: list = []
    async for line in resp.aiter_lines():
        if line == "":
            if data_lines:
                try:
                    payload = json.loads("\n".join(data_lines))
                except json.JSONDecodeError:
                    payload = None
                if isinstance(payload, dict):
                    kind = payload.get("kind") or event_name or "update"
                    yield SSEEvent(kind=kind, data=payload)
            event_name = None
            data_lines = []
            continue
        if line.startswith(":"):
            continue  # heartbeat / comment
        if line.startswith("event:"):
            event_name = line[len("event:") :].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:") :].lstrip())
