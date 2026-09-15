"""Route handlers for the collaborative events (steps) API."""

import asyncio
from typing import Annotated

from datasette import Response
from datasette_plugin_router import Body
from pydantic import ValidationError

from ..router import router
from ..instance import get_registry
from ..errors import (
    BadVersionError,
    GoneError,
    InvalidStepError,
    PaperProtocolError,
)
from ..permissions import can_paper_view, ensure_paper_edit, ensure_paper_view
from ..schemas import EventsBody, EventsQuery, PresenceBody
from ..util import actor_id, paper_db
from .. import sse
from ..sse import (
    ResetReason,
    SSEEvent,
    format_event,
    format_heartbeat,
    send_event,
    send_status,
    start_event_stream,
)


# @feat collab-sse: raw-ASGI SSE route: backlog + live broadcast, 410/400/403
async def sse_events(datasette, request, send, receive):
    """GET /-/paper/api/docs/<doc_id>/events — Server-Sent Events.

    Raw ASGI handler — can't use the route decorator because it needs
    ``send`` / ``receive``. Permission check is inline because
    ``ensure_permission`` raising Forbidden won't be caught by the
    streaming-response middleware.
    """
    try:
        doc_id = int(request.url_vars["doc_id"])
        query = EventsQuery.model_validate(dict(request.args))
    except (TypeError, ValueError, ValidationError):
        await send_status(send, 400, b"Invalid query params")
        return
    version = query.version
    client_id = query.client_id

    if not await can_paper_view(datasette, request.actor, doc_id):
        await send_status(send, 403, b"Permission denied")
        return

    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        await send_status(send, 404, b"Not found")
        return

    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id)

    if version < 0 or version > instance.version:
        await send_status(send, BadVersionError.status, BadVersionError.reason.encode())
        return

    # Subscribe + snapshot the backlog atomically under the instance
    # write lock. Doing this in one operation closes the race where an
    # ``add_events`` could fire between a separate get_events / subscribe
    # call and leave this client one version behind indefinitely.
    try:
        queue, backlog = await instance.subscribe_with_backlog(
            since_version=version,
            client_id=client_id,
            actor_id=actor_id(request),
        )
    except GoneError as exc:
        if client_id is None:
            await send_status(send, exc.status, exc.reason.encode())
            return
        # Native EventSource hides HTTP failure status codes, so a stale
        # idle editor would retry the same evicted version forever. Tell
        # browser editors in-band to re-bootstrap; keep HTTP 410 for
        # callers without a clientID.
        await start_event_stream(send)
        await send_event(
            send,
            SSEEvent.RESET,
            {"reason": ResetReason.HISTORY_GONE},
            more_body=False,
        )
        return
    except BadVersionError as exc:
        await send_status(send, exc.status, exc.reason.encode())
        return

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
        # The initial writes sit inside the try so a client that drops
        # during headers/backlog still hits the ``finally`` unsubscribe —
        # otherwise its queue keeps collecting every later edit.
        await start_event_stream(send)

        # Flush any backlog before reading from the queue. The backlog
        # covers versions up to instance.version as observed at subscribe
        # time; any later ``add_events`` enqueued to ``queue`` for us, so
        # the order on the wire is (backlog, then live broadcasts) with no
        # overlap.
        if backlog is not None:
            await send_event(send, SSEEvent.UPDATE, backlog)

        # Catch-up barrier: always follows the backlog, even an empty one,
        # so editors can hold pending sends until they're caught up instead
        # of racing the backlog. Use the version captured at subscribe time
        # — a write may already have advanced instance.version, and that
        # batch is queued to arrive after this event.
        await send_event(
            send,
            SSEEvent.READY,
            {"version": backlog["version"] if backlog else version},
        )

        # Send the current presence snapshot once so the new subscriber sees
        # everyone already on the doc.
        if instance.presence:
            await send_event(send, SSEEvent.PRESENCE, instance._presence_payload())

        while not disconnected.is_set():
            try:
                payload = await asyncio.wait_for(
                    queue.get(), timeout=sse.HEARTBEAT_SECONDS
                )
                event_name = payload.get("kind", SSEEvent.UPDATE)
                if event_name == SSEEvent.CLOSED:
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
    except (ConnectionError, OSError):
        # The peer went away mid-write; ``finally`` releases the
        # subscription. CancelledError deliberately propagates so the
        # server's own teardown sees it.
        pass
    finally:
        instance.unsubscribe(queue)
        watcher.cancel()
        try:
            await send({"type": "http.response.body", "body": b"", "more_body": False})
        except Exception:
            pass


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/presence$")
# @feat presence: presence POST route over the same SSE channel
async def post_presence(
    datasette, request, doc_id: str, body: Annotated[PresenceBody, Body()]
):
    """Record a client's caret/selection and broadcast to other subscribers."""
    doc_id_int = int(doc_id)
    await ensure_paper_view(datasette, request, doc_id_int)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id_int)
    if doc is None:
        return Response("Not found", status=404)
    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id_int)
    me = actor_id(request)
    # Cache the display name before broadcasting so the payload carries it.
    await instance.ensure_actor_name(datasette, me)
    instance.update_presence(
        client_id=body.client_id,
        actor_id=me,
        anchor=body.anchor,
        head=body.head,
    )
    return Response("", status=204)


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/events$")
# @feat collab-sse: step submission route: Conflict/BadVersion/Gone → 409/400/410
async def post_events(
    datasette, request, doc_id: str, body: Annotated[EventsBody, Body()]
):
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

    try:
        new_version = await instance.add_events(
            version=body.version,
            client_id=body.client_id,
            actor_id=actor_id(request),
            steps=body.steps,
        )
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
            status=exc.status,
        )
    except PaperProtocolError as exc:
        # Conflict / BadVersion / Gone → 409 / 400 / 410, each error
        # carrying its own status and reason.
        return Response(exc.reason, status=exc.status)
    return Response.json({"version": new_version})
