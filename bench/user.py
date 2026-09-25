"""A simulated human on one paper doc.

Mirrors ``frontend/src/lib/collab.ts`` on the wire:

* bootstrap ``GET /api/docs/<id>`` → doc JSON + steps after the snapshot;
* ``GET /api/docs/<id>/events?version=&clientID=`` SSE; hold sends until
  ``ready``; ``update`` batches advance the local model; a version gap
  reopens the stream at our version; ``reset`` (or a 410) re-bootstraps;
* ``POST /events`` ``{version, clientID, steps}`` — 409 means reopen the
  stream, wait for ``ready``, and regenerate (prosemirror-collab would
  rebase the unconfirmed steps; the bench just drops them and produces
  fresh ones against the caught-up doc, which exercises the same server
  path); 410 → full restart; 422 → the model diverged, re-bootstrap;
* ``POST /presence`` debounced at 150 ms during typing;
* ``POST /snapshot`` once 100 steps have landed since the last one, after
  a 5 s debounce, exactly like ``EditorConnection.maybeScheduleSnapshot``;
* an occasional "reload": new clientID, re-bootstrap, new stream. Most
  reloads close the old stream cleanly; some leave the old socket open
  and unread for a while first (the zombie-subscriber scenario).

Roles: ``editor`` (edits a shared doc), ``reader`` (stream + presence
only), ``creator`` (creates its own doc, edits it, trashes it, repeats).
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from dataclasses import dataclass

import httpx2 as httpx

from .docmodel import FlatDoc, UnsupportedDoc, lorem, seed_markdown
from .metrics import Metrics

PRESENCE_DEBOUNCE_S = 0.15
SNAPSHOT_STEP_THRESHOLD = 100
SNAPSHOT_DEBOUNCE_S = 5.0
STREAM_READ_TIMEOUT = 60.0  # server heartbeats every 25 s


@dataclass
class Behaviour:
    think_scale: float = 1.0
    think_min: float = 1.0
    think_max: float = 6.0
    reload_min: float = 60.0
    reload_max: float = 240.0
    stall_prob: float = 0.3  # reloads that leave the old stream open, unread
    stall_seconds: float = 30.0
    creator_edit_min: float = 30.0
    creator_edit_max: float = 90.0
    creator_doc_kb: int = 5


class _Restart(Exception):
    """Raised inside the activity loop to force a full re-bootstrap."""


class SimUser:
    def __init__(
        self,
        uid: int,
        role: str,
        base_url: str,
        cookie: str,
        doc_pool: list[int],
        metrics: Metrics,
        rng: random.Random,
        behaviour: Behaviour,
        stop: asyncio.Event,
    ):
        self.uid = uid
        self.role = role
        self.cookie = cookie
        self.doc_pool = doc_pool
        self.m = metrics
        self.rng = rng
        self.b = behaviour
        self.stop = stop
        self.client = httpx.AsyncClient(
            base_url=base_url,
            cookies={"ds_actor": cookie},
            timeout=httpx.Timeout(30.0, read=STREAM_READ_TIMEOUT),
        )
        self.doc_id: int | None = None
        self.client_id = 0
        self.version = 0
        self.doc = FlatDoc()
        self.last_snapshot_version = 0
        self.lock = asyncio.Lock()  # serialises model updates vs in-flight POST
        self.ready = asyncio.Event()
        self.reset_requested = False
        self.stream_task: asyncio.Task | None = None
        self.stream_gen = 0  # bumps on every open/close; stale tasks bail out
        self.orphans: set[asyncio.Task] = set()  # stalled streams left open
        self.snapshot_task: asyncio.Task | None = None
        self.presence_last = 0.0
        self.log_prefix = f"[u{uid}:{role}]"

    # -- HTTP helpers ------------------------------------------------------

    def api(self, path: str) -> str:
        return f"/-/paper/api/docs/{self.doc_id}{path}"

    async def _post(self, route: str, path: str, body) -> httpx.Response | None:
        t = time.monotonic()
        try:
            r = await self.client.post(path, json=body)
        except httpx.HTTPError as exc:
            self.m.error(route, exc)
            return None
        self.m.record(route, r.status_code, time.monotonic() - t)
        return r

    async def _get(self, route: str, path: str) -> httpx.Response | None:
        t = time.monotonic()
        try:
            r = await self.client.get(path)
        except httpx.HTTPError as exc:
            self.m.error(route, exc)
            return None
        self.m.record(route, r.status_code, time.monotonic() - t)
        return r

    # -- lifecycle ---------------------------------------------------------

    async def run(self) -> None:
        try:
            if self.role == "creator":
                await self._creator_loop()
            else:
                await self._session_loop()
        except asyncio.CancelledError:
            pass
        except Exception as exc:  # keep the run going; surface in metrics
            self.m.error("user", exc)
            print(f"{self.log_prefix} crashed: {exc!r}")
        finally:
            await self._close_stream(clean=True)
            for t in list(self.orphans):
                t.cancel()
            if self.snapshot_task is not None:
                self.snapshot_task.cancel()
            await self.client.aclose()

    async def _session_loop(self) -> None:
        """Editor/reader: pick a doc, live on it, reload now and then."""
        while not self.stop.is_set():
            if self.doc_id is None or self.rng.random() < 0.3:
                self.doc_id = self.rng.choice(self.doc_pool)
            reload_at = time.monotonic() + self.rng.uniform(
                self.b.reload_min, self.b.reload_max
            )
            if not await self._bootstrap_and_open():
                await self._sleep(2.0)
                continue
            try:
                await self._activity_until(reload_at)
            except _Restart:
                self.m.reconnects["restart"] += 1
                await self._close_stream(clean=True)
                continue
            # Reload: sometimes drop the old socket without reading it.
            await self._close_stream(clean=self.rng.random() >= self.b.stall_prob)

    async def _creator_loop(self) -> None:
        while not self.stop.is_set():
            r = await self._post(
                "create",
                "/-/paper/api/docs",
                {
                    "name": f"bench u{self.uid} {int(time.time())}",
                    "content": seed_markdown(self.b.creator_doc_kb * 1024, self.rng),
                },
            )
            if r is None or r.status_code != 201:
                await self._sleep(5.0)
                continue
            self.m.docs_created += 1
            self.doc_id = r.json()["id"]
            until = time.monotonic() + self.rng.uniform(
                self.b.creator_edit_min, self.b.creator_edit_max
            )
            if await self._bootstrap_and_open():
                try:
                    await self._activity_until(until)
                except _Restart:
                    pass
            await self._close_stream(clean=True)
            if self.snapshot_task is not None:
                self.snapshot_task.cancel()  # a snapshot after trash would 404
            r = await self._post("trash", self.api("/trash"), {})
            if r is not None and r.status_code == 200:
                self.m.docs_trashed += 1
            self.doc_id = None
            await self._sleep(self.rng.uniform(5.0, 20.0))

    async def _bootstrap_and_open(self) -> bool:
        self.client_id = self.rng.randrange(0xFFFFFFFF)
        r = await self._get("bootstrap", self.api(""))
        if r is None or r.status_code != 200:
            return False
        boot = r.json()
        try:
            doc = FlatDoc.from_json(boot["doc"])
            doc.apply_all(boot.get("steps") or [])
        except (UnsupportedDoc, KeyError) as exc:
            self.m.error("bootstrap", exc)
            return False
        async with self.lock:
            self.doc = doc
            self.version = int(boot["version"])
            self.last_snapshot_version = int(boot.get("snapshotVersion", 0))
        await self._open_stream()
        return await self._wait_ready()

    # -- SSE stream --------------------------------------------------------

    async def _open_stream(self) -> None:
        self.ready.clear()
        self.reset_requested = False
        self.stream_gen += 1
        self.stream_task = asyncio.create_task(self._stream_loop(self.stream_gen))

    async def _close_stream(self, clean: bool) -> None:
        task, self.stream_task = self.stream_task, None
        self.stream_gen += 1
        if task is None:
            return
        if clean:
            task.cancel()  # httpx closes the socket → server sees disconnect
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        else:
            # Leave the task (and socket) alive but stop reading: the
            # loop sees its generation is stale, idles with the response
            # open, then exits. Tracked so shutdown can cancel it.
            self.m.reconnects["stall"] += 1
            self.orphans.add(task)
            task.add_done_callback(self.orphans.discard)

    async def _wait_ready(self, timeout: float = 30.0) -> bool:
        try:
            await asyncio.wait_for(self.ready.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            self.m.stream_errors["ready_timeout"] += 1
            return False

    async def _stream_loop(self, gen: int) -> None:
        back_off = 0.0
        while not self.stop.is_set() and gen == self.stream_gen:
            url = self.api(f"/events?version={self.version}&clientID={self.client_id}")
            t = time.monotonic()
            try:
                async with self.client.stream("GET", url) as resp:
                    self.m.record("sse_open", resp.status_code, time.monotonic() - t)
                    if resp.status_code == 410:
                        self.m.resets += 1
                        self.reset_requested = True
                        self.ready.set()
                        return
                    if resp.status_code != 200:
                        raise _StreamStatus(resp.status_code)
                    outcome = await self._consume(resp, gen)
                    if outcome == "reset":
                        return
                    if outcome == "stalled":
                        # Unclean reload: hold the socket open, unread.
                        await asyncio.sleep(self.b.stall_seconds)
                        return
                    if outcome == "gap":
                        self.m.reconnects["gap"] += 1
                        back_off = 0.0
                        continue
                    # Server closed the stream (EOF) — reconnect.
                    self.m.reconnects["eof"] += 1
            except asyncio.CancelledError:
                raise
            except (httpx.HTTPError, _StreamStatus, OSError) as exc:
                self.m.stream_errors[type(exc).__name__] += 1
                self.m.reconnects["error"] += 1
            # collab.ts recover(): 200 ms doubling, capped at 60 s.
            back_off = min(back_off * 2, 60.0) if back_off else 0.2
            await asyncio.sleep(back_off)

    async def _consume(self, resp: httpx.Response, gen: int) -> str:
        event = "message"
        data_lines: list[str] = []
        async for line in resp.aiter_lines():
            if gen != self.stream_gen:
                return "stalled"
            line = line.rstrip("\r")
            if line == "":
                if data_lines:
                    outcome = await self._dispatch(event, "\n".join(data_lines))
                    if outcome:
                        return outcome
                event, data_lines = "message", []
            elif line.startswith(":"):
                continue  # heartbeat
            elif line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
        return "eof"

    async def _dispatch(self, event: str, data: str) -> str | None:
        payload = json.loads(data)
        if event == "ready":
            async with self.lock:
                v = int(payload.get("version", self.version))
                if v < self.version:
                    # We're ahead of what the server acked?! treat as gap.
                    self.m.gaps += 1
                    return "gap"
            self.ready.set()
            return None
        if event == "update":
            steps = payload.get("steps") or []
            v = int(payload["version"])
            client_ids = payload.get("clientIDs") or []
            async with self.lock:
                if v - len(steps) != self.version:
                    self.m.gaps += 1
                    return "gap"
                try:
                    self.doc.apply_all(steps)
                except UnsupportedDoc as exc:
                    self.m.error("apply", exc)
                    print(f"{self.log_prefix} model out of sync at v{v}: {exc}")
                    self.reset_requested = True
                    self.ready.set()
                    return "reset"
                self.version = v
                self.m.steps_received += len(steps)
            if client_ids and self.doc_id is not None:
                self.m.lag_observe(self.doc_id, int(client_ids[0]), v)
            return None
        if event == "reset":
            self.m.resets += 1
            self.reset_requested = True
            self.ready.set()
            return "reset"
        # presence / renamed / state-changed / permissions-changed: ignore.
        return None

    # -- activity ----------------------------------------------------------

    async def _activity_until(self, deadline: float) -> None:
        while not self.stop.is_set() and time.monotonic() < deadline:
            if self.reset_requested:
                raise _Restart()
            if self.role == "reader":
                await self._presence()
                await self._sleep(self.rng.uniform(5.0, 20.0))
                continue
            await self._think()
            await self._one_action()

    async def _think(self) -> None:
        await self._sleep(
            self.rng.uniform(self.b.think_min, self.b.think_max) * self.b.think_scale
        )

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self.stop.wait(), seconds)
        except asyncio.TimeoutError:
            pass

    async def _one_action(self) -> None:
        rng = self.rng
        x = rng.random()
        if x < 0.55:
            # Typing burst: several small batches ~250 ms apart, presence
            # debounced alongside (the caret moves with every keystroke).
            batches = rng.randint(3, 10)
            for _ in range(batches):
                if self.stop.is_set():
                    return
                await self._send(lambda d: d.gen_typing(rng, rng.randint(1, 4)))
                await self._presence()
                await self._sleep(rng.uniform(0.15, 0.35))
        elif x < 0.67:
            await self._send(lambda d: d.gen_delete(rng))
            await self._presence()
        elif x < 0.72:
            await self._send(lambda d: d.gen_paste(rng, rng.randint(500, 3000)))
        elif x < 0.82:
            await self._send(lambda d: d.gen_mark(rng))
        elif x < 0.87:
            await self._send(lambda d: d.gen_new_paragraph(rng, rng.randint(20, 120)))
        elif x < 0.90:
            await self._send(lambda d: d.gen_delete_paragraph(rng))
        else:
            await self._sleep(rng.uniform(5.0, 20.0))  # reading / idle

    async def _presence(self) -> None:
        now = time.monotonic()
        if now - self.presence_last < PRESENCE_DEBOUNCE_S:
            return
        self.presence_last = now
        size = max(self.doc.size - 1, 1)
        pos = self.rng.randint(1, size)
        await self._post(
            "presence",
            self.api("/presence"),
            {"clientID": self.client_id, "anchor": pos, "head": pos},
        )

    async def _send(self, gen) -> None:
        """Generate steps against the current doc and POST them; handle 409/410/422."""
        for _attempt in range(4):
            if self.reset_requested:
                raise _Restart()
            async with self.lock:
                steps = gen(self.doc)
                if not steps:
                    return
                version = self.version
                body = {"version": version, "clientID": self.client_id, "steps": steps}
                self.m.lag_register(self.doc_id, self.client_id, version + len(steps))
                r = await self._post("events", self.api("/events"), body)
                if r is not None and r.status_code == 200:
                    self.doc.apply_all(steps)
                    self.version = int(r.json()["version"])
                    self.m.steps_sent += len(steps)
                    self._maybe_schedule_snapshot()
                    return
            if r is None:
                await self._sleep(1.0)
                continue
            if r.status_code == 409:
                # Stale: reopen the stream at our version and wait for the
                # ready barrier, then regenerate against the caught-up doc.
                self.m.reconnects["409"] += 1
                await self._close_stream(clean=True)
                await self._open_stream()
                if not await self._wait_ready():
                    raise _Restart()
                continue
            if r.status_code == 410:
                self.m.resets += 1
                raise _Restart()
            if r.status_code == 422:
                print(f"{self.log_prefix} 422 invalid step: {r.text[:200]}")
                raise _Restart()
            # 4xx/5xx: counted via status; back off a little.
            await self._sleep(1.0)
            return

    def _maybe_schedule_snapshot(self) -> None:
        if self.version - self.last_snapshot_version < SNAPSHOT_STEP_THRESHOLD:
            return
        if self.snapshot_task is not None and not self.snapshot_task.done():
            self.snapshot_task.cancel()
        self.snapshot_task = asyncio.create_task(self._snapshot_after_debounce())

    async def _snapshot_after_debounce(self) -> None:
        await asyncio.sleep(SNAPSHOT_DEBOUNCE_S)
        r = await self._post("snapshot", self.api("/snapshot"), {})
        if r is not None and r.status_code == 200:
            try:
                self.last_snapshot_version = int(r.json()["version"])
            except (KeyError, ValueError):
                pass


class _StreamStatus(Exception):
    def __init__(self, status: int):
        super().__init__(f"stream status {status}")
        self.status = status


__all__ = ["SimUser", "Behaviour", "lorem"]
