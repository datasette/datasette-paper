"""In-memory collaborative editing instance and registry.

Per-doc lifecycle:

    hydrate(doc_id)
      → select_latest_snapshot + select_steps_after  (steps_tail, MAX_TAIL=10000)
      → version = snapshot_version + len(steps_after)
    add_events(version, client_id, actor_id, steps)
      → acquire ``_write_lock`` (serializes the whole pipeline against
        concurrent add_events / subscribe-backlog on this instance)
      → validate version (BadVersion / Conflict)
      → json.dumps each step (TEXT column)
      → validate steps against the live doc (raises InvalidStepError)
      → insert_step in one execute_write_fn txn (atomic)
      → append to steps_tail
      → broadcast {kind:"update", steps[parsed], clientIDs, users}
        (skips the originator's clientID — they self-confirmed via POST 200)
    append_fragment(fragment_json, actor_id) — server-side markdown/content
      ingest: builds one ReplaceStep at end-of-doc against the live doc under
      ``_write_lock`` and runs the same persist+broadcast tail as add_events,
      stamped with the ``_API_CLIENT_ID`` sentinel (no originator to skip).
    apply_markdown_edit(edit_fn, actor_id) — atomic markdown read-modify-write
      for the agent edit/insert tools: under ``_write_lock``, serialize the
      live doc to markdown, run ``edit_fn`` over it, reparse, and replace the
      whole doc with one ReplaceStep.
    get_events(since_version) — backlog slice for SSE replay; raises GoneError
    subscribe_with_backlog(since_version, client_id, actor_id) —
        atomically subscribes and snapshots the backlog under the same
        lock as ``add_events``, so the SSE handler can't miss a
        broadcast that fires between the two steps.
    subscribe(client_id, actor_id) → asyncio.Queue (key in self.subscribers)
    update_presence(...) → broadcasts {kind:"presence", users:[…]}
    record_client_doc(...) → snapshot row when (version - last) >= 100;
        also driven automatically by ``_maybe_auto_snapshot`` at the end of
        every write, so API-only docs (no browser to POST /snapshot) still
        snapshot and don't grow an unbounded step tail.
    revoke_unauthorized(datasette) → re-checks "paper-view" per
        subscriber; enqueues {"kind":"closed"} for any who lost access;
        the SSE loop sees the sentinel and exits cleanly.
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import time
from typing import Optional

from .db import PaperDB
from .errors import BadVersionError, ConflictError, GoneError, InvalidStepError
from .sql import _queries

logger = logging.getLogger("datasette_paper.instance")

MAX_INSTANCES = 20
MAX_TAIL = 10000
SNAPSHOT_THRESHOLD = 100

# Hard cap on a single step's serialized JSON size. The markdown-parser and
# browser-paste guards strip oversized inline `data:` images on the two normal
# entry paths, but a malicious or buggy client can POST an arbitrary
# ``ReplaceStep`` carrying a multi-MB image node straight to the events route,
# bypassing both. Every step rides the append-only log + snapshots + the SSE
# broadcast, so reject anything over this as the broadest backstop — it also
# caps non-image step abuse. Sized comfortably above a legitimate inline image
# (~8 MB raw → ~11 MB base64) plus step framing.
MAX_STEP_BYTES = 12 * 1024 * 1024
# How long a resolved display name stays cached before the next presence
# POST re-resolves it, so a profile rename surfaces without re-hydrating.
ACTOR_NAME_TTL_SECONDS = 300

# Sentinel client_id stamped on steps produced by the server itself (the
# markdown append/ingest API), as opposed to a prosemirror-collab client.
# Collab clientIDs are random non-negative 32-bit ints, so a negative value
# can never collide with a real subscriber — meaning the broadcast loop's
# "skip the originator" check never skips anyone for an API-originated step,
# and every live editor receives it.
_API_CLIENT_ID = -1


def empty_doc_json() -> str:
    return '{"type":"doc","content":[{"type":"paragraph"}]}'


def _step_record(row) -> dict:
    """Convert a Step row into the in-memory tail dict."""
    return {
        "version": row.version,
        "client_id": row.client_id,
        "actor_id": row.actor_id,
        "step_json": row.step_json,
        "created_at": row.created_at,
    }


class Instance:
    """In-memory state for a single collaborative document."""

    def __init__(
        self,
        db: PaperDB,
        doc_id: int,
        version: int,
        snapshot_version: int,
        snapshot_doc_json: str,
        steps_tail: collections.deque,
    ) -> None:
        self.db = db
        self.doc_id = doc_id
        self.version = version
        self.snapshot_version = snapshot_version
        self.snapshot_doc_json = snapshot_doc_json
        self.steps_tail: collections.deque = steps_tail
        # queue → (client_id, actor_id). client_id may be None for read-only
        # / pre-handshake subscribers; used to skip echoes back to the
        # originator when broadcasting their own step batch. actor_id is
        # used by ``revoke_unauthorized`` to drop subscribers whose access
        # has been removed.
        self.subscribers: dict[asyncio.Queue, tuple[Optional[int], Optional[str]]] = {}
        # client_id → {actor_id, anchor, head, ts}. Updated on every
        # presence POST and pruned when subscribers leave.
        self.presence: dict[int, dict] = {}
        # actor_id → (display name, resolved-at monotonic ts). Populated
        # lazily by ``ensure_actor_name`` (re-resolved past
        # ACTOR_NAME_TTL_SECONDS) and surfaced in the presence payload so
        # remote cursors show a profile name rather than the raw id.
        self.actor_names: dict[str, tuple[str, float]] = {}
        self.last_active: float = time.monotonic()
        # Cached live doc (snapshot + applied steps_tail). Lazy: built on
        # first materialize call, invalidated by version mismatch.
        self._cached_live_doc_json: Optional[str] = None
        self._cached_live_version: Optional[int] = None
        # Set by ``materialize_live_doc`` when a step in history fails to
        # apply: ``(failing_version, error_message)``. Persists alongside
        # the cached partial doc so writers can refuse new edits without
        # repeating the materialization work. Cleared at the top of each
        # full re-materialization.
        self._materialization_error: Optional[tuple[int, str]] = None
        # Doc version at which link edges were last reindexed. Lets the write
        # tail skip a redundant reindex when nothing advanced the version.
        # In-memory: lost on eviction/rehydrate, which just means one cheap
        # idempotent reindex on the next write — fine.
        self._links_indexed_version: Optional[int] = None
        # Doc version at which the inline-#tag index was last rebuilt. Same
        # in-memory guard idiom as ``_links_indexed_version``.
        self._tags_indexed_version: Optional[int] = None
        # Serializes ``add_events`` and the subscribe+backlog snapshot in
        # ``subscribe_with_backlog`` so the Python-level state transitions
        # (version check → validate → write → tail append → broadcast)
        # match the SQL write queue's atomicity. Without it two concurrent
        # POSTs at the same version both pass the version check, both
        # validate against the same pre-write doc, and the second one's
        # step lands on top of the first one's — producing a tail with
        # duplicate versions, double-broadcasts to other subscribers, and
        # (when the two steps' positions interact) a step that fails to
        # replay on hydrate and surfaces as "ask an admin to fix" in the
        # client.
        self._write_lock: asyncio.Lock = asyncio.Lock()

    @classmethod
    # @feat snapshot-log: load latest snapshot + steps_after into the in-memory tail
    async def hydrate(cls, db: PaperDB, doc_id: int) -> "Instance":
        """Load instance state from the database."""
        snapshot = await db.select_latest_snapshot(doc_id=doc_id)
        if snapshot is None:
            snapshot_version = 0
            snapshot_doc_json = empty_doc_json()
        else:
            snapshot_version = snapshot.version
            snapshot_doc_json = snapshot.doc_json

        steps_after = await db.select_steps_after(
            doc_id=doc_id, after_version=snapshot_version
        )

        steps_tail: collections.deque = collections.deque(maxlen=MAX_TAIL)
        true_version = snapshot_version
        for step in steps_after:
            steps_tail.append(_step_record(step))
            true_version = step.version

        return cls(
            db=db,
            doc_id=doc_id,
            version=true_version,
            snapshot_version=snapshot_version,
            snapshot_doc_json=snapshot_doc_json,
            steps_tail=steps_tail,
        )

    # @feat snapshot-log: apply steps_tail over snapshot via prosemirror-py (cached)
    def materialize_live_doc(self) -> dict:
        """Return the live doc as a JSON dict (snapshot + applied steps_tail).

        Cached on the instance and invalidated automatically by version
        mismatch — `add_events` doesn't have to actively bust the cache.

        On step-apply failure, returns the doc as far as steps successfully
        applied, plus logs a warning. Should never raise.
        """
        if (
            self._cached_live_doc_json is not None
            and self._cached_live_version == self.version
        ):
            return json.loads(self._cached_live_doc_json)

        # Late imports keep the prosemirror dep optional at module-load
        # time and avoid pulling lxml on cold paths that don't need it.
        from prosemirror.transform import Step

        from .pm_schema import schema

        # Re-materializing — wipe any prior poisoned-history marker so a
        # subsequently repaired tail (admin trimmed the bad step, the
        # registry was forced to re-hydrate) clears the gate cleanly.
        self._materialization_error = None

        try:
            doc = schema.node_from_json(json.loads(self.snapshot_doc_json))
        except Exception:
            logger.exception(
                "doc_id=%s: snapshot_doc_json failed to parse, returning raw",
                self.doc_id,
            )
            return json.loads(self.snapshot_doc_json)

        for record in self.steps_tail:
            try:
                step = Step.from_json(schema, json.loads(record["step_json"]))
                result = step.apply(doc)
                if result.failed:
                    logger.warning(
                        "doc_id=%s version=%s: Step.apply failed: %s",
                        self.doc_id,
                        record["version"],
                        result.failed,
                    )
                    self._materialization_error = (record["version"], result.failed)
                    break
                doc = result.doc
            except Exception as exc:
                logger.exception(
                    "doc_id=%s version=%s: Step.apply raised",
                    self.doc_id,
                    record["version"],
                )
                self._materialization_error = (record["version"], str(exc))
                break

        live = doc.to_json()
        self._cached_live_doc_json = json.dumps(live)
        self._cached_live_version = self.version
        return live

    def _raise_if_poisoned(self) -> None:
        """Reject a write if a step in history couldn't be materialized.

        When materialization fails partway, ``materialize_live_doc`` returns the
        doc as of the last good version while the instance's version counter
        still reflects the FULL count — so client batches are positioned against
        a doc state the server can't reproduce. Raise with a clear marker rather
        than letting each step fail individually with a misleading position
        error. Callers that must not fail the write path (link reindex, auto
        snapshot) check ``_materialization_error`` and skip instead.
        """
        if self._materialization_error is not None:
            bad_version, bad_msg = self._materialization_error
            raise InvalidStepError(
                0, f"history corrupted at version {bad_version}: {bad_msg}"
            )

    def _validate_steps(self, step_jsons: list[str]) -> None:
        """Apply each step against a clone of the live doc; raise on first failure.

        Runs purely in-memory — no DB writes happen until the caller has
        cleared this gate. The doc clone is discarded; the real
        materialization still flows through ``materialize_live_doc`` on
        the next read.

        Raises ``InvalidStepError`` with the offending 0-based batch index.
        """
        # Late imports keep prosemirror off the cold-path module import.
        from prosemirror.model import ReplaceError
        from prosemirror.transform import Step

        from .pm_schema import schema, step_href_violation

        live_json = self.materialize_live_doc()
        self._raise_if_poisoned()
        try:
            doc = schema.node_from_json(live_json)
        except Exception as exc:
            # Live doc itself doesn't parse — can't validate against
            # something we can't materialize. Surface as step 0.
            raise InvalidStepError(0, f"materialized doc invalid: {exc}") from exc

        for i, step_json in enumerate(step_jsons):
            # Broadest backstop: a step over the size cap is rejected before
            # we even parse it. Catches an oversized inline `data:` image (or
            # any other bloat) POSTed directly, which the markdown-parser and
            # browser-paste guards never see.
            if len(step_json) > MAX_STEP_BYTES:
                raise InvalidStepError(
                    i,
                    f"step too large ({len(step_json)} bytes; max {MAX_STEP_BYTES})",
                )
            try:
                parsed = json.loads(step_json)
                step = Step.from_json(schema, parsed)
            except Exception as exc:
                raise InvalidStepError(i, f"step parse failed: {exc}") from exc
            # Defense-in-depth (CLAUDE.md / blockers-0629/01): reject a crafted
            # step that plants a `javascript:` (or other blocked-scheme) href on
            # a link mark or image src. The browser render sink neutralizes it
            # on display, but a direct POST to /events bypasses the UI entirely —
            # stop it at persistence so it never reaches the step log or SSE.
            violation = step_href_violation(parsed)
            if violation is not None:
                raise InvalidStepError(i, violation)
            try:
                result = step.apply(doc)
            except (ReplaceError, ValueError) as exc:
                # `ReplaceError` is what `from_replace` catches today;
                # `ValueError` is what `Node.check_content` raises on a
                # content-spec violation, which `from_replace` does NOT
                # catch (the gap that caused this whole class of bug).
                raise InvalidStepError(i, str(exc)) from exc
            if result.failed:
                raise InvalidStepError(i, result.failed)
            doc = result.doc

    # @feat collab-sse: server version check under write-lock: BadVersion/Conflict + validate
    async def add_events(
        self,
        version: int,
        client_id: int,
        actor_id: Optional[str],
        steps: list[str],
    ) -> int:
        """Persist steps, broadcast to subscribers, and return new version.

        The whole pipeline runs under ``self._write_lock`` so two
        concurrent callers at the same version don't both pass the
        version check and end up writing rebased-incorrectly steps. The
        lock spans the DB write — Datasette's write queue is global, so
        we're not adding new serialization beyond what the underlying
        write already requires.
        """
        async with self._write_lock:
            if version < 0 or version > self.version:
                raise BadVersionError(
                    f"Version {version} is invalid (server version: {self.version})"
                )
            if version != self.version:
                raise ConflictError(
                    f"Version {version} != server version {self.version}"
                )

            if not steps:
                return self.version

            # The wire format delivers steps as parsed JSON (lists/dicts).
            # The `step_json` column stores them as TEXT, so serialize each
            # step back to a JSON string before binding. Strings come
            # through as-is.
            step_jsons = [s if isinstance(s, str) else json.dumps(s) for s in steps]

            # Validate every step against the current live doc before
            # writing any of them. The wire `Step.from_json` + `Step.apply`
            # accepts malformed payloads silently — `apply` only catches
            # `ReplaceError`, so a content-spec violation raises a bare
            # `ValueError` from `Node.check_content` that escapes both
            # apply and `StepResult`. Catch both shapes here and reject
            # the batch with `InvalidStepError` so the client gets a
            # structured 422 instead of a 200 that poisons the history.
            self._validate_steps(step_jsons)

            return await self._persist_and_broadcast(step_jsons, client_id, actor_id)

    async def _persist_and_broadcast(
        self,
        step_jsons: list[str],
        client_id: int,
        actor_id: Optional[str],
    ) -> int:
        """Write a validated, correctly-positioned step batch and broadcast it.

        **Caller must hold ``self._write_lock``** and must have already
        validated ``step_jsons`` against the current live doc — this method
        does no version or content checking. It's the shared tail of
        ``add_events`` (collab POSTs) and ``append_fragment`` (API ingest);
        the two differ only in how they produce + position the steps.
        """
        base_version = self.version

        def write_all(conn):
            new_ver = base_version
            for step_json in step_jsons:
                inserted = _queries.insert_step(
                    conn,
                    doc_id=self.doc_id,
                    client_id=client_id,
                    actor_id=actor_id,
                    step_json=step_json,
                )
                assert inserted is not None
                new_ver = inserted
                _queries.bump_doc_version(conn, doc_id=self.doc_id, version=new_ver)
            # @feat profile-papers: record this actor's edit for the profile
            # "Papers" rollup. This closure — not PaperDB.insert_step — is the
            # real choke point every live append (collab POST + markdown
            # append_fragment) funnels through; anonymous edits don't attribute.
            if actor_id is not None and new_ver != base_version:
                _queries.upsert_doc_activity(
                    conn, doc_id=self.doc_id, actor_id=actor_id
                )
            return new_ver

        new_version = await self.db.database.execute_write_fn(write_all)

        # Fetch the newly inserted steps to get their created_at values. Safe
        # under the lock — no other writer can have advanced the version while
        # we awaited the write, so this returns exactly our batch.
        new_steps = await self.db.select_steps_after(
            doc_id=self.doc_id, after_version=base_version
        )

        new_step_records = [_step_record(row) for row in new_steps]
        for record in new_step_records:
            self.steps_tail.append(record)

        self.version = new_version

        # Broadcast to all subscribers. Steps are stored as JSON strings;
        # parse them back to objects so the SSE payload is structured JSON,
        # not strings inside a JSON array.
        payload = {
            "kind": "update",
            "version": self.version,
            "steps": [json.loads(r["step_json"]) for r in new_step_records],
            "clientIDs": [r["client_id"] for r in new_step_records],
            "users": len(self.subscribers),
        }
        # Skip the originator: their POST 200 already confirmed these steps
        # locally via prosemirror-collab's receiveTransaction. Sending the
        # echo would cause them to re-apply the step on top of the already-
        # confirmed state (the unconfirmed queue is empty, so PM would treat
        # it as a remote insertion and duplicate the change). API-originated
        # appends use a sentinel client_id (``_API_CLIENT_ID``) that matches
        # no real subscriber, so every live editor receives them.
        for q, (sub_client_id, _actor_id) in list(self.subscribers.items()):
            if sub_client_id is not None and sub_client_id == client_id:
                continue
            q.put_nowait(payload)

        self.last_active = time.monotonic()
        await self._maybe_auto_snapshot(actor_id)
        await self.reindex_links()
        await self.reindex_tags()
        return self.version

    async def reindex_tags(self) -> None:
        """Rebuild this doc's inline-#tag index rows from the live doc.

        Mirror of :meth:`reindex_links`: called from the write tail, guarded so
        it never raises into the write path (skips a poisoned history and a
        redundant re-run, swallows + logs any persistence error). Keeps
        ``_datasette_paper_inline_tag`` current as of the latest write, which is
        what ``GET /tags/{slug}/refs`` joins against.
        """
        if self._materialization_error is not None:
            return
        if self._tags_indexed_version == self.version:
            return
        try:
            live_json = self.materialize_live_doc()
            if self._materialization_error is not None:
                return
            from .tags import extract_tags

            tags: dict[str, int] = {}
            for slug in extract_tags(live_json):
                tags[slug] = tags.get(slug, 0) + 1
            await self.db.replace_inline_tags(
                doc_id=self.doc_id,
                src_version=self.version,
                tags=tags,
            )
            self._tags_indexed_version = self.version
        except Exception:
            logger.exception("inline-tag reindex failed for doc %s", self.doc_id)

    # @feat snapshot-log: write-tail reindex of derived rows off the materialized doc
    async def reindex_links(self) -> None:
        """Rebuild this doc's outgoing link edges from the live doc.

        Called from the write tail. Guarded so it never raises into the write
        path: skips a poisoned history and a redundant re-run, and swallows +
        logs any persistence error (an edge-index failure must not fail the
        user's edit).
        """
        if self._materialization_error is not None:
            return
        if self._links_indexed_version == self.version:
            return
        try:
            live_json = self.materialize_live_doc()
            if self._materialization_error is not None:
                return
            from .links import extract_links

            edges: dict[int, int] = {}
            for dst in extract_links(live_json):
                edges[dst] = edges.get(dst, 0) + 1
            await self.db.replace_links(
                src_doc_id=self.doc_id,
                src_version=self.version,
                edges=edges,
            )
            self._links_indexed_version = self.version
        except Exception:
            logger.exception("link reindex failed for doc %s", self.doc_id)

    async def _maybe_auto_snapshot(self, actor_id: Optional[str]) -> None:
        """Snapshot when the step tail has drifted past the threshold.

        Browsers drive snapshots via ``POST /snapshot``, but API-only docs
        (markdown append / agent edits) have no browser, so without this their
        step tail would grow without bound and every hydrate would replay from
        version 0. Called at the end of every write under ``_write_lock``, so
        the snapshot reflects exactly the version we just committed. Skips a
        poisoned history rather than persisting a doc we can't cleanly rebuild;
        ``record_client_doc`` re-checks the threshold so this is a no-op until
        the drift is actually reached.
        """
        if (self.version - self.snapshot_version) < SNAPSHOT_THRESHOLD:
            return
        materialized = self.materialize_live_doc()
        if self._materialization_error is not None:
            return
        await self.record_client_doc(
            self.version, json.dumps(materialized), actor_id=actor_id
        )

    async def append_fragment(
        self,
        fragment_json: list[dict],
        actor_id: Optional[str] = None,
    ) -> int:
        """Append top-level block nodes to the end of the doc as one step.

        ``fragment_json`` is a list of ProseMirror block-node dicts (e.g. the
        output of ``markdown_parser.markdown_to_fragment``). The step is built
        against the *current* live doc under ``self._write_lock`` so it can't
        race a concurrent collab write — the insertion position and the
        validation both see the same doc state the write will land on. Returns
        the new version; a no-op (empty fragment) returns the current version.

        Raises :class:`InvalidStepError` if history is poisoned or the
        fragment can't be inserted at the end of the doc under the schema.
        """
        if not fragment_json:
            return self.version

        # Late imports keep prosemirror off the cold module-import path.
        from prosemirror.model import Fragment, Node, Slice
        from prosemirror.transform import ReplaceStep

        from .pm_schema import schema

        async with self._write_lock:
            live_json = self.materialize_live_doc()
            self._raise_if_poisoned()

            try:
                doc = schema.node_from_json(live_json)
                nodes = [Node.from_json(schema, block) for block in fragment_json]
            except Exception as exc:
                raise InvalidStepError(0, f"invalid fragment: {exc}") from exc

            end = doc.content.size
            step = ReplaceStep(end, end, Slice(Fragment.from_array(nodes), 0, 0))
            result = step.apply(doc)
            if result.failed:
                raise InvalidStepError(0, result.failed)

            step_json = json.dumps(step.to_json())
            return await self._persist_and_broadcast(
                [step_json], _API_CLIENT_ID, actor_id
            )

    async def apply_markdown_edit(self, edit_fn, actor_id: Optional[str] = None) -> int:
        """Atomically read the doc as markdown, transform it, and replace it.

        ``edit_fn(markdown: str) -> str`` produces the new full-document
        markdown from the current one (e.g. a str-replace or an insert). The
        whole read → transform → reparse → replace sequence runs under
        ``self._write_lock``, so ``edit_fn`` sees — and the resulting step is
        positioned against — the same live doc the step lands on, even if a
        collab client is editing concurrently. The doc is replaced wholesale
        with one ``ReplaceStep`` over the reparsed markdown.

        Returns the new version, or the current version if ``edit_fn`` is a
        no-op (returns identical markdown). ``edit_fn`` may raise to signal a
        failed edit (e.g. an ambiguous match); the exception propagates to
        the caller. Raises :class:`InvalidStepError` if history is poisoned
        or the reparsed doc can't replace the current one under the schema.
        """
        from prosemirror.model import Fragment, Node, Slice
        from prosemirror.transform import ReplaceStep

        from .markdown import doc_to_markdown
        from .markdown_parser import markdown_to_doc
        from .pm_schema import schema

        async with self._write_lock:
            live_json = self.materialize_live_doc()
            self._raise_if_poisoned()

            current_md = doc_to_markdown(live_json)
            new_md = edit_fn(current_md)
            if new_md == current_md:
                return self.version  # no-op edit

            new_blocks = markdown_to_doc(new_md).get("content") or []
            try:
                old_doc = schema.node_from_json(live_json)
                new_nodes = [Node.from_json(schema, b) for b in new_blocks]
            except Exception as exc:
                raise InvalidStepError(0, f"reparsed doc invalid: {exc}") from exc

            step = ReplaceStep(
                0, old_doc.content.size, Slice(Fragment.from_array(new_nodes), 0, 0)
            )
            result = step.apply(old_doc)
            if result.failed:
                raise InvalidStepError(0, result.failed)

            step_json = json.dumps(step.to_json())
            return await self._persist_and_broadcast(
                [step_json], _API_CLIENT_ID, actor_id
            )

    def get_events(self, since_version: int) -> Optional[dict]:
        """Return steps since since_version, or None if already up to date."""
        if since_version == self.version:
            return None

        if since_version < 0 or since_version > self.version:
            raise BadVersionError(
                f"Version {since_version} is invalid (server version: {self.version})"
            )

        # Oldest version available in tail
        tail_len = len(self.steps_tail)
        oldest_available = self.version - tail_len

        if since_version < oldest_available:
            raise GoneError(
                f"Version {since_version} is too old; "
                f"oldest available: {oldest_available}"
            )

        # Slice from tail
        steps_needed = self.version - since_version
        tail_list = list(self.steps_tail)
        sliced = tail_list[tail_len - steps_needed :]

        return {
            "kind": "update",
            "version": self.version,
            "steps": [json.loads(r["step_json"]) for r in sliced],
            "clientIDs": [r["client_id"] for r in sliced],
            "users": len(self.subscribers),
        }

    async def subscribe(
        self,
        client_id: Optional[int] = None,
        actor_id: Optional[str] = None,
    ) -> asyncio.Queue:
        """Create a new subscriber queue and return it.

        ``client_id`` (the prosemirror-collab clientID) lets ``add_events``
        skip echoing a step batch back to its originator. ``actor_id``
        is used by :meth:`revoke_unauthorized` to drop subscribers whose
        access has been removed via the share-state endpoint.

        Live SSE handlers should call :meth:`subscribe_with_backlog`
        instead — it atomically pairs the subscribe with a backlog
        snapshot so events broadcast between the two can't be lost.
        """
        q: asyncio.Queue = asyncio.Queue()
        self.subscribers[q] = (client_id, actor_id)
        return q

    async def subscribe_with_backlog(
        self,
        since_version: int,
        client_id: Optional[int] = None,
        actor_id: Optional[str] = None,
    ) -> tuple[asyncio.Queue, Optional[dict]]:
        """Subscribe and snapshot the backlog atomically.

        Returns ``(queue, backlog)`` where ``backlog`` is either ``None``
        (caller is already up to date) or a payload identical in shape to
        what :meth:`add_events` broadcasts, covering versions
        ``(since_version, self.version]`` as observed under the lock.

        Holding ``self._write_lock`` for the duration means no
        ``add_events`` can fire between (a) the backlog snapshot and
        (b) the queue being registered in ``self.subscribers``. Any
        subsequent ``add_events`` either waits on the lock (and
        therefore writes its broadcast into our queue) or already saw
        the queue and pushed into it. Either way, no broadcast falls in
        the gap that the old ``get_events`` → ``subscribe`` ordering had.

        Raises :class:`GoneError` / :class:`BadVersionError` the same
        way :meth:`get_events` does.
        """
        async with self._write_lock:
            backlog = self.get_events(since_version)
            # Compose with ``subscribe`` rather than inlining the queue
            # creation so tests / hooks that monkey-patch
            # ``instance.subscribe`` (e.g. to flag "the route has
            # subscribed now") still trigger. The whole operation stays
            # under the lock because ``subscribe`` doesn't await.
            q = await self.subscribe(client_id=client_id, actor_id=actor_id)
            return q, backlog

    def unsubscribe(self, q: asyncio.Queue) -> None:
        """Remove a subscriber queue and any presence entry for that client."""
        entry = self.subscribers.pop(q, None)
        if entry is None:
            return
        client_id, _actor_id = entry
        if client_id is not None and client_id in self.presence:
            del self.presence[client_id]
            # Re-broadcast presence so others see them go away. Fire and
            # forget — we're inside a sync method called from the SSE
            # cleanup path, so we can't await.
            self._broadcast_presence_nowait()

    def broadcast_state_changed(self, payload: dict) -> None:
        """Push a ``state-changed`` event to every subscriber.

        Caller assembles the payload with the post-update state /
        timestamp fields. Used by the archive / unarchive / trash /
        restore routes so currently-editing collaborators see the doc
        switch state without needing to refetch the bootstrap.
        """
        msg = {"kind": "state-changed", **payload}
        for q in list(self.subscribers):
            q.put_nowait(msg)

    async def broadcast_permissions_changed(self, datasette, locked: bool) -> None:
        """Push a per-subscriber ``permissions-changed`` event after a lock flip.

        Lock affects only the edit grant — owner keeps edit, share +
        visibility editors lose it (or regain it on unlock). ``canEdit``
        is recomputed per subscriber via
        ``datasette.allowed("paper-edit", ...)`` so each
        client sees the new capability with no reconnect.

        The ``locked`` field is included as a convenience for any UI
        that wants to show a "this doc is locked" banner regardless of
        the subscriber's role.
        """
        from .permissions import PaperDocResource, PAPER_EDIT

        resource = PaperDocResource(self.doc_id)
        for q, (_client_id, actor_id) in list(self.subscribers.items()):
            actor = {"id": actor_id} if actor_id else None
            can_edit = await datasette.allowed(
                action=PAPER_EDIT, resource=resource, actor=actor
            )
            q.put_nowait(
                {
                    "kind": "permissions-changed",
                    "canEdit": can_edit,
                    "locked": locked,
                }
            )

    async def revoke_unauthorized(self, datasette) -> int:
        """Close subscriber queues whose actor no longer passes view.

        Called after a share mutation commits. Re-runs
        ``datasette.allowed("paper-view", ...)`` per subscriber;
        any deny enqueues a ``{"kind": "closed"}`` sentinel so the SSE
        loop sees ``event_name == "closed"`` and exits cleanly, and the
        queue is removed from ``self.subscribers``.

        Returns the number of subscribers that were revoked.
        """
        from .permissions import PaperDocResource, PAPER_VIEW

        revoked = 0
        resource = PaperDocResource(self.doc_id)
        for q, (_client_id, actor_id) in list(self.subscribers.items()):
            actor = {"id": actor_id} if actor_id else None
            allowed = await datasette.allowed(
                action=PAPER_VIEW, resource=resource, actor=actor
            )
            if not allowed:
                # Sentinel — the SSE loop checks `event_name == "closed"`
                # and breaks out of its forwarding loop cleanly. Simpler
                # than a separate channel.
                q.put_nowait({"kind": "closed"})
                self.subscribers.pop(q, None)
                revoked += 1
        return revoked

    # ── Presence ──────────────────────────────────────────────────────────────

    # @feat presence: track per-subscriber cursor state + name fallback, broadcast
    def update_presence(
        self,
        client_id: int,
        actor_id: Optional[str],
        anchor: int,
        head: int,
    ) -> None:
        """Record a client's caret/selection and broadcast to subscribers."""
        self.presence[client_id] = {
            "actor_id": actor_id,
            "anchor": anchor,
            "head": head,
            "ts": time.monotonic(),
        }
        self._broadcast_presence_nowait()

    async def ensure_actor_name(self, datasette, actor_id: Optional[str]) -> None:
        """Resolve and cache an actor's display name, refreshing if stale.

        Resolution goes through datasette-user-profiles with the same
        fallback chain as the rest of the plugin, ending at the actor id
        itself — so the cache always holds something printable. Cheap and
        bounded: at most one resolution per distinct participant per
        ACTOR_NAME_TTL_SECONDS window.
        """
        if not actor_id:
            return
        cached = self.actor_names.get(actor_id)
        if cached and (time.monotonic() - cached[1]) < ACTOR_NAME_TTL_SECONDS:
            return
        from .util import resolve_actor_profiles

        profiles = await resolve_actor_profiles(datasette, [actor_id])
        prof = profiles.get(actor_id)
        # resolve_actor_profiles falls back to the id, so name is non-empty.
        name = (prof or {}).get("name") or actor_id
        self.actor_names[actor_id] = (name, time.monotonic())

    def _name_for(self, actor_id: Optional[str]) -> Optional[str]:
        entry = self.actor_names.get(actor_id) if actor_id else None
        return entry[0] if entry else None

    def _presence_payload(self) -> dict:
        return {
            "kind": "presence",
            "users": [
                {
                    "clientID": cid,
                    "actorID": entry["actor_id"],
                    "name": self._name_for(entry["actor_id"]),
                    "anchor": entry["anchor"],
                    "head": entry["head"],
                }
                for cid, entry in self.presence.items()
            ],
        }

    def _broadcast_presence_nowait(self) -> None:
        """Push the current presence list to every subscriber queue."""
        payload = self._presence_payload()
        for q in list(self.subscribers):
            q.put_nowait(payload)

    # @feat snapshot-log: write periodic snapshot, prune folded steps, compact log
    async def record_client_doc(
        self,
        version: int,
        doc_json: str,
        actor_id: Optional[str] = None,
    ) -> None:
        """Persist a snapshot if threshold since last snapshot has been reached."""
        if (version - self.snapshot_version) >= SNAPSHOT_THRESHOLD:
            await self.db.insert_snapshot(
                doc_id=self.doc_id,
                version=version,
                doc_json=doc_json,
                actor_id=actor_id,
            )
            self.snapshot_version = version
            self.snapshot_doc_json = doc_json
            # The tail loaded at hydrate covers steps after the OLD snapshot.
            # Anything at or below the new snapshot is now baked into
            # snapshot_doc_json; leaving it in the tail would make the next
            # materialize re-apply already-applied steps on top of the new
            # base — same positions, very different doc — and surface as e.g.
            # "Structure gap-replace would overwrite content" partway through.
            while self.steps_tail and self.steps_tail[0]["version"] <= version:
                self.steps_tail.popleft()
            # Cached live doc + any poisoned-history marker were computed
            # from the old base; both are stale now.
            self._cached_live_doc_json = None
            self._cached_live_version = None
            self._materialization_error = None
            # Compact the on-disk log to match: the steps we just popped from
            # the tail are now baked into the snapshot, and older snapshots are
            # dead weight. Without this both tables grow without bound. A client
            # asking for evicted history gets a 410 → full re-bootstrap, so this
            # is safe. Guarded so a compaction failure can't fail the user's
            # edit (it runs in the write tail).
            try:
                await self.db.compact_doc(doc_id=self.doc_id, version=version)
            except Exception:
                logger.exception(
                    "step/snapshot compaction failed for doc %s", self.doc_id
                )


class InstanceRegistry:
    """LRU cache of Instance objects, keyed by doc_id.

    Papers live in Datasette's single internal DB so the doc_id alone is
    a globally unique key — no need to disambiguate by database name.
    """

    def __init__(self) -> None:
        self._instances: collections.OrderedDict = collections.OrderedDict()

    async def get(self, db: PaperDB, doc_id: int) -> Instance:
        key = doc_id

        if key in self._instances:
            self._instances.move_to_end(key)
            inst = self._instances[key]
            inst.last_active = time.monotonic()
            return inst

        inst = await Instance.hydrate(db, doc_id)
        self._instances[key] = inst

        # Evict LRU if over limit
        while len(self._instances) > MAX_INSTANCES:
            self._instances.popitem(last=False)

        return inst


def get_registry(datasette) -> InstanceRegistry:
    """Get or create the InstanceRegistry attached to this Datasette instance."""
    if not hasattr(datasette, "_paper_registry"):
        datasette._paper_registry = InstanceRegistry()
    return datasette._paper_registry
