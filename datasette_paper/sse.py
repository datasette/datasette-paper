"""SSE wire format for datasette-paper: event names, payload shapes, framing.

The names in :class:`SSEEvent` are the protocol; ``frontend/src/lib/collab.ts``
mirrors them in its ``SSE_EVENT`` table. Subscriber queues carry the same
names in their ``kind`` field so the streaming loop can forward a payload
without a lookup table.
"""

import json
from enum import Enum
from typing import Awaitable, Callable, TypedDict, Union

HEARTBEAT_SECONDS = 25.0  # module-level so tests can monkeypatch

Send = Callable[[dict], Awaitable[None]]


class SSEEvent(str, Enum):
    """Every event name the SSE GET can emit, plus the in-queue sentinels."""

    # Step batch: a live broadcast or the catch-up backlog.
    UPDATE = "update"
    # Catch-up barrier: follows the backlog (even an empty one); clients
    # hold sends until it lands.
    READY = "ready"
    # History behind the requested version is gone; re-bootstrap.
    RESET = "reset"
    PRESENCE = "presence"
    STATE_CHANGED = "state-changed"
    RENAMED = "renamed"
    PERMISSIONS_CHANGED = "permissions-changed"
    # Queue-only sentinel: the stream loop exits instead of forwarding it.
    CLOSED = "closed"

    def __str__(self) -> str:  # f-strings / format() → the wire name
        return self.value


class ResetReason(str, Enum):
    HISTORY_GONE = "history_gone"

    def __str__(self) -> str:
        return self.value


class ReadyEvent(TypedDict):
    version: int


class ResetEvent(TypedDict):
    reason: ResetReason


EVENT_STREAM_HEADERS = [
    (b"content-type", b"text/event-stream"),
    (b"cache-control", b"no-cache"),
    # Tell nginx-style proxies not to buffer the stream.
    (b"x-accel-buffering", b"no"),
]


def format_event(event: Union[SSEEvent, str], data: Union[dict, str]) -> bytes:
    body = data if isinstance(data, str) else json.dumps(data)
    return f"event: {event}\ndata: {body}\n\n".encode("utf-8")


def format_heartbeat() -> bytes:
    return b": heartbeat\n\n"


async def start_event_stream(send: Send) -> None:
    """Emit the 200 + ``text/event-stream`` response head."""
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": list(EVENT_STREAM_HEADERS),
        }
    )


async def send_event(
    send: Send,
    event: Union[SSEEvent, str],
    data: Union[dict, str],
    *,
    more_body: bool = True,
) -> None:
    """Write one framed event; ``more_body=False`` also ends the response."""
    await send(
        {
            "type": "http.response.body",
            "body": format_event(event, data),
            "more_body": more_body,
        }
    )


async def send_status(send: Send, status: int, body: bytes) -> None:
    """Plain-text non-stream reply (400/403/404/410) from the raw ASGI route."""
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"text/plain")],
        }
    )
    await send({"type": "http.response.body", "body": body, "more_body": False})
