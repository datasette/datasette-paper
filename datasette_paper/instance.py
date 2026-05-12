"""In-memory collaborative editing instance and registry.

Per-doc lifecycle:

    hydrate(doc_id)
      → select_latest_snapshot + select_steps_after  (steps_tail, MAX_TAIL=10000)
      → version = snapshot_version + len(steps_after)
    add_events(version, client_id, actor_id, steps)
      → validate version (BadVersion / Conflict)
      → json.dumps each step (TEXT column)
      → insert_step in one execute_write_fn txn (atomic)
      → append to steps_tail
      → broadcast {kind:"update", steps[parsed], clientIDs, users}
        (skips the originator's clientID — they self-confirmed via POST 200)
    get_events(since_version) — backlog slice for SSE replay; raises GoneError
    subscribe(client_id, actor_id) → asyncio.Queue (key in self.subscribers)
    update_presence(...) → broadcasts {kind:"presence", users:[…]}
    record_client_doc(...) → snapshot row when (version - last) >= 100
    revoke_unauthorized(datasette) → re-checks "datasette-paper-view" per
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

    @classmethod
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

        from .pm_schema import schema

        live_json = self.materialize_live_doc()
        # If a step in history couldn't be applied during materialization,
        # ``live_json`` is the doc as of the last good version — but the
        # instance's version counter is the FULL count, so client batches
        # are positioned against a doc state the server can't reproduce.
        # Reject with a clear marker rather than letting each step fail
        # individually with a misleading position error.
        if self._materialization_error is not None:
            bad_version, bad_msg = self._materialization_error
            raise InvalidStepError(
                0,
                f"history corrupted at version {bad_version}: {bad_msg}",
            )
        try:
            doc = schema.node_from_json(live_json)
        except Exception as exc:
            # Live doc itself doesn't parse — can't validate against
            # something we can't materialize. Surface as step 0.
            raise InvalidStepError(0, f"materialized doc invalid: {exc}") from exc

        for i, step_json in enumerate(step_jsons):
            try:
                step = Step.from_json(schema, json.loads(step_json))
            except Exception as exc:
                raise InvalidStepError(i, f"step parse failed: {exc}") from exc
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

    async def add_events(
        self,
        version: int,
        client_id: int,
        actor_id: Optional[str],
        steps: list[str],
    ) -> int:
        """Persist steps, broadcast to subscribers, and return new version."""
        if version < 0 or version > self.version:
            raise BadVersionError(
                f"Version {version} is invalid (server version: {self.version})"
            )
        if version != self.version:
            raise ConflictError(f"Version {version} != server version {self.version}")

        if not steps:
            return self.version

        base_version = self.version
        # The wire format delivers steps as parsed JSON (lists/dicts). The
        # `step_json` column stores them as TEXT, so serialize each step
        # back to a JSON string before binding. Strings come through as-is.
        step_jsons = [s if isinstance(s, str) else json.dumps(s) for s in steps]

        # Validate every step against the current live doc before writing
        # any of them. The wire `Step.from_json` + `Step.apply` accepts
        # malformed payloads silently — `apply` only catches `ReplaceError`,
        # so a content-spec violation raises a bare `ValueError` from
        # `Node.check_content` that escapes both apply and `StepResult`.
        # Catch both shapes here and reject the batch with `InvalidStepError`
        # so the client gets a structured 422 instead of a 200 that poisons
        # the history.
        self._validate_steps(step_jsons)

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
            return new_ver

        new_version = await self.db.database.execute_write_fn(write_all)

        # Fetch the newly inserted steps to get their created_at values
        new_steps = await self.db.select_steps_after(
            doc_id=self.doc_id, after_version=base_version
        )

        # Append to tail
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
        # echo would cause them to re-apply the step on top of the
        # already-confirmed state (the unconfirmed queue is empty, so PM
        # would treat it as a remote insertion and duplicate the change).
        for q, (sub_client_id, _actor_id) in list(self.subscribers.items()):
            if sub_client_id is not None and sub_client_id == client_id:
                continue
            q.put_nowait(payload)

        self.last_active = time.monotonic()
        return self.version

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
        """
        q: asyncio.Queue = asyncio.Queue()
        self.subscribers[q] = (client_id, actor_id)
        return q

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

    async def revoke_unauthorized(self, datasette) -> int:
        """Close subscriber queues whose actor no longer passes view.

        Called after a share mutation commits. Re-runs
        ``datasette.allowed("datasette-paper-view", ...)`` per subscriber;
        any deny enqueues a sentinel ``None`` so the SSE loop exits and
        the queue is unsubscribed.

        Returns the number of subscribers that were revoked.
        """
        from .permissions import PaperResource

        revoked = 0
        resource = PaperResource(self.doc_id)
        for q, (_client_id, actor_id) in list(self.subscribers.items()):
            actor = {"id": actor_id} if actor_id else None
            allowed = await datasette.allowed(
                action="datasette-paper-view", resource=resource, actor=actor
            )
            if not allowed:
                # Sentinel — the SSE loop's queue.get() returns None and the
                # loop's `payload.get(...)` raises AttributeError; catch
                # there and exit cleanly. Simpler than a separate channel.
                q.put_nowait({"kind": "closed"})
                self.subscribers.pop(q, None)
                revoked += 1
        return revoked

    # ── Presence ──────────────────────────────────────────────────────────────

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

    def _presence_payload(self) -> dict:
        return {
            "kind": "presence",
            "users": [
                {
                    "clientID": cid,
                    "actorID": entry["actor_id"],
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
