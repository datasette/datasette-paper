"""Tests for GET /-/paper/api/docs/:id/events (SSE downstream stream)."""

from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

import pytest

import datasette_paper.sse as sse_module
from datasette_paper.instance import get_registry
import datasette_paper.instance as instance_module

from _steps import insert_at  # noqa: E402  (sibling helper)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_doc(datasette, name="Test Paper"):
    resp = await datasette.client.post(
        "/-/paper/api/docs",
        json={"name": name},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


async def _post_step(datasette, doc_id, version, client_id=1):
    url = f"/-/paper/api/docs/{doc_id}/events"
    body = {
        "version": version,
        "clientID": client_id,
        # Always insert at position 1 (start of the paragraph) — position-
        # stable so a sequence of these always validates against the live
        # doc regardless of where we are in the run.
        "steps": [insert_at(1)],
        "comment": [],
    }
    resp = await datasette.client.post(url, json=body)
    assert resp.status_code == 200
    return resp.json()["version"]


# ---------------------------------------------------------------------------
# ASGI SSE harness
# ---------------------------------------------------------------------------


class SSEStream:
    """Low-level ASGI test harness for SSE endpoints."""

    def __init__(self, app, path: str, *, cookie_header: bytes | None = None):
        self._app = app
        self._path = path
        self._cookie_header = cookie_header
        self._status: int | None = None
        self._headers: list | None = None
        self._body_queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._disconnect_event = asyncio.Event()
        self._request_complete = False

    async def _receive(self):
        if not self._request_complete:
            self._request_complete = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await self._disconnect_event.wait()
        return {"type": "http.disconnect"}

    async def _send(self, message: dict):
        if message["type"] == "http.response.start":
            self._status = message["status"]
            self._headers = message.get("headers", [])
        elif message["type"] == "http.response.body":
            body = message.get("body", b"")
            if body:
                await self._body_queue.put(body)
            if not message.get("more_body", False):
                await self._body_queue.put(None)

    def disconnect(self):
        self._disconnect_event.set()

    async def run(self):
        qs = self._path.split("?", 1)
        path = qs[0]
        query_string = qs[1].encode() if len(qs) > 1 else b""
        headers = []
        if self._cookie_header is not None:
            headers.append((b"cookie", self._cookie_header))
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "headers": headers,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": query_string,
            "server": ("testserver", 80),
            "client": ("127.0.0.1", 12345),
            "root_path": "",
        }
        await self._app(scope, self._receive, self._send)

    @property
    def status(self) -> int | None:
        return self._status

    async def chunks(self) -> AsyncIterator[bytes]:
        while True:
            chunk = await self._body_queue.get()
            if chunk is None:
                break
            yield chunk

    async def read_one_update_event(self, timeout: float = 5.0) -> dict:
        buf = ""
        deadline = asyncio.get_event_loop().time() + timeout
        async for chunk in self.chunks():
            buf += chunk.decode("utf-8", errors="replace")
            while "\n\n" in buf:
                block, buf = buf.split("\n\n", 1)
                lines = block.strip().splitlines()
                ev_type = data_str = None
                for line in lines:
                    if line.startswith("event:"):
                        ev_type = line[len("event:") :].strip()
                    elif line.startswith("data:"):
                        data_str = line[len("data:") :].strip()
                if ev_type == "update" and data_str is not None:
                    return json.loads(data_str)
            if asyncio.get_event_loop().time() > deadline:
                raise TimeoutError("Timed out reading SSE update event")
        raise EOFError("SSE stream ended without an update event")


async def _sse_get(
    datasette,
    path: str,
    *,
    timeout: float = 5.0,
    actor_id: str = "alice",
) -> SSEStream:
    """Open an SSE stream as ``actor_id`` (matches conftest's default)."""
    cookie_header: bytes | None = None
    if actor_id is not None:
        signed = datasette.sign({"a": {"id": actor_id}}, "actor")
        cookie_header = f"ds_actor={signed}".encode()
    stream = SSEStream(datasette.app(), path, cookie_header=cookie_header)
    task = asyncio.create_task(stream.run())
    stream._task = task  # type: ignore[attr-defined]

    deadline = asyncio.get_event_loop().time() + timeout
    while stream.status is None:
        await asyncio.sleep(0)
        if asyncio.get_event_loop().time() > deadline:
            task.cancel()
            raise TimeoutError("Timed out waiting for SSE response headers")
    return stream


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sse_streams_step_after_post(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    registry = get_registry(ds)
    instance = await registry.get(paper_db, doc_id)

    subscribed = asyncio.Event()
    orig_subscribe = instance.subscribe

    async def patched_subscribe(client_id=None, actor_id=None):
        q = await orig_subscribe(client_id=client_id, actor_id=actor_id)
        subscribed.set()
        return q

    instance.subscribe = patched_subscribe

    path = f"/-/paper/api/docs/{doc_id}/events?version=0"
    stream = await _sse_get(ds, path)
    assert stream.status == 200

    await asyncio.wait_for(subscribed.wait(), timeout=5.0)

    new_version = await _post_step(ds, doc_id, version=0, client_id=7)
    assert new_version == 1

    try:
        event = await asyncio.wait_for(stream.read_one_update_event(), timeout=5.0)
    finally:
        stream.disconnect()
        stream._task.cancel()
        try:
            await stream._task
        except (asyncio.CancelledError, Exception):
            pass

    assert event["version"] == 1
    assert len(event["steps"]) == 1
    assert event["clientIDs"][0] == 7


@pytest.mark.asyncio
async def test_sse_backlog_replay(ds):
    doc_id = await _create_doc(ds)

    for i in range(3):
        await _post_step(ds, doc_id, version=i)

    path = f"/-/paper/api/docs/{doc_id}/events?version=0"
    stream = await _sse_get(ds, path)
    assert stream.status == 200

    try:
        event = await asyncio.wait_for(stream.read_one_update_event(), timeout=5.0)
    finally:
        stream.disconnect()
        stream._task.cancel()
        try:
            await stream._task
        except (asyncio.CancelledError, Exception):
            pass

    assert event["version"] == 3
    assert len(event["steps"]) == 3
    assert len(event["clientIDs"]) == 3


@pytest.mark.asyncio
# @feat collab-sse: test: evicted-history SSE subscribe returns 410
async def test_sse_stale_version_410(ds_paper):
    import collections

    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    registry = get_registry(ds)

    inst = await instance_module.Instance.hydrate(paper_db, doc_id)
    inst.steps_tail = collections.deque(maxlen=2)
    registry._instances[doc_id] = inst

    for i in range(5):
        # Position-stable insert so each step validates regardless of
        # MAX_TAIL eviction.
        await inst.add_events(
            version=i,
            client_id=1,
            actor_id=None,
            steps=[insert_at(1)],
        )

    path = f"/-/paper/api/docs/{doc_id}/events?version=0"
    stream = await _sse_get(ds, path)
    await asyncio.sleep(0.05)
    assert stream.status == 410


@pytest.mark.asyncio
async def test_sse_heartbeat(ds, monkeypatch):
    monkeypatch.setattr(sse_module, "HEARTBEAT_SECONDS", 0.05)

    doc_id = await _create_doc(ds)

    path = f"/-/paper/api/docs/{doc_id}/events?version=0"
    stream = await _sse_get(ds, path)
    assert stream.status == 200

    heartbeat_found = False
    buf = b""

    async def _read_for_heartbeat():
        nonlocal heartbeat_found, buf
        async for chunk in stream.chunks():
            buf += chunk
            if b": heartbeat" in buf:
                heartbeat_found = True
                return

    try:
        await asyncio.wait_for(_read_for_heartbeat(), timeout=2.0)
    except asyncio.TimeoutError:
        pass
    finally:
        stream.disconnect()
        stream._task.cancel()
        try:
            await stream._task
        except (asyncio.CancelledError, Exception):
            pass

    assert heartbeat_found, f"No heartbeat found in: {buf!r}"


@pytest.mark.asyncio
async def test_sse_unsubscribe_on_disconnect(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    registry = get_registry(ds)
    instance = await registry.get(paper_db, doc_id)

    assert len(instance.subscribers) == 0

    subscribed = asyncio.Event()
    orig_subscribe = instance.subscribe

    async def patched_subscribe(client_id=None, actor_id=None):
        q = await orig_subscribe(client_id=client_id, actor_id=actor_id)
        subscribed.set()
        return q

    instance.subscribe = patched_subscribe

    path = f"/-/paper/api/docs/{doc_id}/events?version=0"
    stream = await _sse_get(ds, path)
    assert stream.status == 200

    await asyncio.wait_for(subscribed.wait(), timeout=5.0)
    assert len(instance.subscribers) == 1

    stream.disconnect()
    stream._task.cancel()
    try:
        await stream._task
    except (asyncio.CancelledError, Exception):
        pass

    await asyncio.sleep(0.2)

    assert len(instance.subscribers) == 0, (
        f"Expected 0 subscribers, got {len(instance.subscribers)}"
    )
