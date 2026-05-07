"""Small SSE formatting helpers for datasette-paper."""

import json

HEARTBEAT_SECONDS = 25.0  # module-level so tests can monkeypatch


def format_event(event: str, data: "dict | str") -> bytes:
    body = data if isinstance(data, str) else json.dumps(data)
    return f"event: {event}\ndata: {body}\n\n".encode("utf-8")


def format_heartbeat() -> bytes:
    return b": heartbeat\n\n"
