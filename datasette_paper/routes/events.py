"""Route handlers for the collaborative events (steps) API."""

import asyncio

from datasette import Response

from ..router import router
from ..instance import get_registry
from ..errors import (
    BadVersionError,
    ConflictError,
    GoneError,
    InvalidStepError,
)
from ..permissions import can_paper_view, ensure_paper_edit, ensure_paper_view
from ..util import read_json_body, actor_id, paper_db
from .. import sse
from ..sse import format_event, format_heartbeat


async def _send_status(send, status: int, body: bytes) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"text/plain")],
        }
    )
    await send({"type": "http.response.body", "body": body, "more_body": False})


async def sse_events(datasette, request, send, receive):
    """GET /-/paper/api/docs/<doc_id>/events — Server-Sent Events.

    Raw ASGI handler — can't use the route decorator because it needs
    ``send`` / ``receive``. Permission check is inline because
    ``ensure_permission`` raising Forbidden won't be caught by the
    streaming-response middleware.
    """
    doc_id_str = request.url_vars["doc_id"]
    try:
        doc_id = int(doc_id_str)
        version = int(request.args.get("version", "0"))
    except (TypeError, ValueError):
        await _send_status(send, 400, b"Invalid query params")
        return

    if not await can_paper_view(datasette, request.actor, doc_id):
        await _send_status(send, 403, b"Permission denied")
        return

    # Optional clientID — when present, the broadcast loop skips this
    # subscriber for batches it originated, so the client doesn't re-apply
    # its own already-acknowledged steps.
    client_id_raw = request.args.get("clientID")
    try:
        client_id = int(client_id_raw) if client_id_raw is not None else None
    except (TypeError, ValueError):
        client_id = None

    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        await _send_status(send, 404, b"Not found")
        return

    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id)

    if version < 0 or version > instance.version:
        await _send_status(send, 400, b"Invalid version")
        return

    # Check if version is too old (will raise GoneError) before opening SSE.
    # We only need to call get_events here for validation / backlog retrieval.
    try:
        backlog = instance.get_events(version)
    except (GoneError, BadVersionError) as exc:
        if isinstance(exc, GoneError):
            await _send_status(send, 410, b"History gone")
        else:
            await _send_status(send, 400, b"Invalid version")
        return

    # --- Open the SSE stream ---
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [
                (b"content-type", b"text/event-stream"),
                (b"cache-control", b"no-cache"),
                (b"x-accel-buffering", b"no"),
            ],
        }
    )

    # Flush any backlog immediately before subscribing so no events are lost.
    if backlog is not None:
        await send(
            {
                "type": "http.response.body",
                "body": format_event("update", backlog),
                "more_body": True,
            }
        )

    queue = await instance.subscribe(
        client_id=client_id,
        actor_id=actor_id(request),
    )

    # Send the current presence snapshot once so the new subscriber sees
    # everyone already on the doc.
    if instance.presence:
        await send(
            {
                "type": "http.response.body",
                "body": format_event("presence", instance._presence_payload()),
                "more_body": True,
            }
        )

    disconnected = asyncio.Event()

    async def watch_disconnect():
        try:
            while True:
                msg = await receive()
                if msg.get("type") == "http.disconnect":
                    disconnected.set()
                    return
        except Exception:
            disconnected.set()

    watcher = asyncio.create_task(watch_disconnect())
    try:
        while not disconnected.is_set():
            try:
                payload = await asyncio.wait_for(
                    queue.get(), timeout=sse.HEARTBEAT_SECONDS
                )
                event_name = payload.get("kind", "update")
                if event_name == "closed":
                    # Server-initiated close — emitted by
                    # Instance.revoke_unauthorized when an actor's
                    # access is removed mid-session.
                    break
                body = format_event(event_name, payload)
            except asyncio.TimeoutError:
                if disconnected.is_set():
                    break
                body = format_heartbeat()
            try:
                await send(
                    {
                        "type": "http.response.body",
                        "body": body,
                        "more_body": True,
                    }
                )
            except Exception:
                break
    except (asyncio.CancelledError, ConnectionError, OSError):
        pass
    finally:
        instance.unsubscribe(queue)
        watcher.cancel()
        try:
            await send({"type": "http.response.body", "body": b"", "more_body": False})
        except Exception:
            pass


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/presence$")
async def post_presence(datasette, request, doc_id: str):
    """Record a client's caret/selection and broadcast to other subscribers."""
    doc_id_int = int(doc_id)
    await ensure_paper_view(datasette, request, doc_id_int)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id_int)
    if doc is None:
        return Response("Not found", status=404)
    body = await read_json_body(request)
    try:
        client_id = int(body["clientID"])
        anchor = int(body["anchor"])
        head = int(body["head"])
    except (KeyError, TypeError, ValueError):
        return Response.json({"error": "invalid presence body"}, status=400)
    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id_int)
    instance.update_presence(
        client_id=client_id,
        actor_id=actor_id(request),
        anchor=anchor,
        head=head,
    )
    return Response("", status=204)


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/events$")
async def post_events(datasette, request, doc_id: str):
    doc_id_int = int(doc_id)
    await ensure_paper_edit(datasette, request, doc_id_int)
    db = paper_db(datasette)

    # Check doc exists before touching the registry; POST events must NOT
    # create a doc implicitly.
    doc = await db.select_doc_by_id(doc_id_int)
    if doc is None:
        return Response("Not found", status=404)

    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id_int)

    body = await read_json_body(request)
    try:
        new_version = await instance.add_events(
            version=body["version"],
            client_id=body["clientID"],
            actor_id=actor_id(request),
            steps=body["steps"],
        )
    except ConflictError:
        return Response("Version not current", status=409)
    except BadVersionError:
        return Response("Invalid version", status=400)
    except GoneError:
        return Response("History gone", status=410)
    except InvalidStepError as exc:
        # The batch was rejected before any write — the doc's
        # _datasette_paper_step table is untouched. Return enough
        # structure that the client can identify the failing step and
        # stop sending; the user is told to refresh.
        return Response.json(
            {
                "error": "invalid_step",
                "step_index": exc.step_index,
                "message": exc.message,
            },
            status=422,
        )
    return Response.json({"version": new_version})
