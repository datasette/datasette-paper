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


class ForbiddenError(PaperError):
    """403 — the server refused the write (no edit permission / doc locked)."""


class ReadOnlyError(PaperError):
    """Local refusal — the session has no edit permission, so nothing is sent.

    Distinct from :class:`ForbiddenError` (a server 403): this is the
    client-side gate that spares a doomed round-trip when ``can_edit`` is
    False (a locked or view-only doc)."""


class _ChangedRemotely:
    """Result sentinel for :meth:`DocSession.locate_block`: the target block
    was edited or deleted by someone else, so no unique range matches its
    ``old_json`` and nothing can be safely replaced. Not an error — it's the
    expected outcome of a concurrent same-block edit, handled by the UI's
    keep-mine / take-theirs prompt."""

    __slots__ = ()


CHANGED_REMOTELY = _ChangedRemotely()


@dataclass
class SaveResult:
    """Outcome of a :meth:`DocSession.save_block` / ``save_block_json`` attempt.

    ``kind`` is one of:

    - ``"saved"`` — the step landed; ``version`` is the new doc version.
    - ``"needs_delete_confirm"`` — the text parsed to nothing (an implicit
      block deletion); the UI must confirm, then call again with
      ``confirmed_delete=True``.
    - ``"changed_remotely"`` — the block was edited/deleted concurrently and
      can't be located (even after one catch-up + retry); ``their_markdown``
      is the block's current text (``""`` if it was removed) for the
      keep-mine / take-theirs prompt. Nothing was written.
    - ``"reload"`` — used by the modal to signal the screen to rebuild after a
      take-theirs (no save happened, but the local doc advanced).
    """

    kind: str
    version: Optional[int] = None
    their_markdown: Optional[str] = None


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
        server_url: Optional[str] = None,
    ) -> None:
        # The real, browser-reachable origin — used only by "open in browser"
        # actions. None in standalone (internal.db) mode, where there is no
        # server: those actions degrade to a notification instead.
        self.server_url = server_url
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
        async with self.lock:
            return await self._submit_replace_locked(start, end, nodes)

    async def _submit_replace_locked(self, start: int, end: int, nodes: list) -> int:
        """Core of :meth:`submit_replace` that assumes ``self.lock`` is already
        held. Split out so the block-edit save path can hold the lock across
        *both* the locate and the submit — an SSE batch landing between them
        would shift positions and corrupt the range (locate-under-lock)."""
        from prosemirror.model import Fragment, Node, Slice
        from prosemirror.transform import ReplaceStep

        from ..pm_schema import schema

        pm_nodes = [
            n if isinstance(n, Node) else Node.from_json(schema, n) for n in nodes
        ]
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
        if resp.status_code == 403:
            raise ForbiddenError("Edit refused (no permission or doc locked)")
        if resp.status_code == 422:
            body = resp.json()
            raise InvalidStepError(body.get("message") or "Invalid step")
        resp.raise_for_status()

        new_version = resp.json()["version"]
        self.doc = result.doc
        self.version = new_version
        return new_version

    # @feat tui: locate a top-level block by index / unique-JSON scan (relocation)
    def locate_block(self, i: int, old_json: dict):
        """Find the ``[start, end]`` position range of the block whose content
        was ``old_json`` at edit-start, tolerating that concurrent edits may
        have shifted it.

        Resolution order (see plans/tui/03-editing.md):

        1. If child ``i`` still serializes to ``old_json``, it's the target.
        2. Else scan every child for a *unique* ``old_json`` match (the block
           moved because earlier blocks were added/removed).
        3. Otherwise return :data:`CHANGED_REMOTELY` — the block itself was
           edited or deleted concurrently (no match, or ambiguous duplicates).

        Positions are top-level offsets: ``start`` is the summed ``node_size``
        of the children before the target, ``end`` is ``start`` plus the
        target's ``node_size``."""
        doc = self.doc
        n = doc.child_count
        if 0 <= i < n and doc.child(i).to_json() == old_json:
            target = i
        else:
            matches = [k for k in range(n) if doc.child(k).to_json() == old_json]
            if len(matches) != 1:
                return CHANGED_REMOTELY
            target = matches[0]
        start = sum(doc.child(k).node_size for k in range(target))
        end = start + doc.child(target).node_size
        return (start, end)

    def _current_block_md(self, i: int) -> str:
        """Markdown of child ``i`` right now (for the conflict prompt's "theirs"
        side), or ``""`` if that index no longer exists (removed remotely)."""
        return self.block_markdown(i) if 0 <= i < self.doc.child_count else ""

    async def _wait_for_catch_up(
        self, prev_version: int, catch_up, timeout: float = 5.0
    ) -> None:
        """Bounded wait for the local version to advance past ``prev_version``
        after a 409, so the retry relocates against the caught-up doc.

        In the app the live SSE worker delivers the missed batch and bumps
        ``self.version`` concurrently, so we just poll it. Tests (and any caller
        without a running SSE loop) pass ``catch_up`` — an async hook that
        fetches the missed steps and applies them — instead. Never hangs: the
        poll is time-boxed and the retry proceeds regardless."""
        if catch_up is not None:
            await catch_up()
            return
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while self.version <= prev_version and loop.time() < deadline:
            await asyncio.sleep(0.05)

    # @feat tui: block edit save path — locate under lock, submit, 409-retry once
    async def _save_nodes(self, i: int, old_json: dict, nodes: list, *, catch_up=None):
        """Shared locate + submit core for ``save_block`` / ``save_block_json``.

        Holds ``self.lock`` across the locate *and* the submit (positions can't
        shift under us). On a 409 it releases the lock, waits for catch-up, then
        relocates and retries exactly once; a second 409 becomes a
        ``changed_remotely`` result. A 410 (``GoneError``) propagates to the
        screen, which owns re-bootstrap."""
        if not self.can_edit:
            raise ReadOnlyError("Document is read-only")
        for attempt in range(2):  # initial try + one post-catch-up retry
            prev_version = self.version
            async with self.lock:
                loc = self.locate_block(i, old_json)
                if loc is CHANGED_REMOTELY:
                    return SaveResult(
                        "changed_remotely", their_markdown=self._current_block_md(i)
                    )
                start, end = loc
                try:
                    version = await self._submit_replace_locked(start, end, nodes)
                    return SaveResult("saved", version=version)
                except ConflictError:
                    if attempt == 1:
                        # One retry already spent — hand the conflict to the UI.
                        return SaveResult(
                            "changed_remotely",
                            their_markdown=self._current_block_md(i),
                        )
            # Lock released: let the SSE stream (or the test hook) catch us up,
            # then loop to relocate + retry.
            await self._wait_for_catch_up(prev_version, catch_up)
        # Defensive: the loop always returns inside the body.
        return SaveResult("changed_remotely", their_markdown=self._current_block_md(i))

    # @feat tui: block edit save path — markdown -> fragment -> locate + submit
    async def save_block(
        self,
        i: int,
        old_json: dict,
        text: str,
        *,
        confirmed_delete: bool = False,
        catch_up=None,
    ) -> SaveResult:
        """Replace block ``i`` (identified by ``old_json`` at edit-start) with
        the blocks parsed from ``text``.

        Empty / whitespace-only ``text`` parses to no nodes — a block deletion.
        Unless ``confirmed_delete`` is set, that returns
        ``SaveResult("needs_delete_confirm")`` so the UI can confirm first. A
        single edit may legitimately parse to several blocks (the user typed a
        blank line); the fragment replaces the range wholesale, which is fine."""
        from ..markdown_parser import markdown_to_fragment

        nodes = markdown_to_fragment(text)
        if not nodes and not confirmed_delete:
            return SaveResult("needs_delete_confirm")
        return await self._save_nodes(i, old_json, nodes, catch_up=catch_up)

    # @feat tui: block edit save path — programmatic variant (task toggle etc.)
    async def save_block_json(
        self, i: int, old_json: dict, new_json_nodes: list, *, catch_up=None
    ) -> SaveResult:
        """Like :meth:`save_block` but takes ready PM node JSON instead of
        markdown — used by the task-checkbox toggle, which mutates ``checked``
        in the block JSON and re-derives without a markdown round-trip."""
        return await self._save_nodes(
            i, old_json, list(new_json_nodes), catch_up=catch_up
        )


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
