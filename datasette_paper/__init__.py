import re

from datasette import hookimpl, Response
from datasette.permissions import Action
from datasette_vite import vite_entry
from datasette_acl.roles import standard_roles
from datasette_acl_share import datasette_share_assets as _share_assets
from .router import router
from .permissions import (  # noqa: F401
    PaperDocResource,
    permission_resources_sql,
    PAPER_DOC_RESOURCE_TYPE,
    PAPER_VIEW,
    PAPER_EDIT,
    PAPER_MANAGE,
)
from . import routes  # noqa: F401 — triggers decorator registration
from .routes.events import sse_events
import logging

logger = logging.getLogger(__name__)


def _method_dispatch_routes(raw_routes):
    """Combine routes with the same path pattern into method-dispatching views.

    ``datasette_plugin_router`` registers GET and POST for the same URL as
    separate ``(pattern, view)`` tuples, but Datasette matches only the *first*
    pattern that fits.  Here we group by path and build a single wrapper that
    returns 405 for unsupported methods.
    """
    from collections import defaultdict

    by_path = defaultdict(dict)  # path -> {METHOD: view_fn}
    order = []  # preserve registration order for first-seen path

    for entry in router._routes:
        path = entry.path
        method = entry.method.upper()
        if path not in by_path:
            order.append(path)
        by_path[path][method] = entry.fn

    result = []
    for path in order:
        method_map = by_path[path]
        if len(method_map) == 1:
            # No conflict — use view directly
            result.append((path, next(iter(method_map.values()))))
        else:
            # Build a dispatcher. The inner view fns from datasette_plugin_router
            # have the signature (request, datasette=None, scope=None, receive=None, send=None).
            # Datasette's wrap_view_function will call this dispatcher via
            # async_call_with_supported_arguments, injecting datasette/request/send etc.
            # Use a factory to capture _map in a closure, avoiding default-arg
            # inspection issues with async_call_with_supported_arguments.
            def _make_dispatcher(m):
                async def dispatcher(
                    request,
                    datasette=None,
                    scope=None,
                    receive=None,
                    send=None,
                ):
                    method = request.method.upper()
                    handler = m.get(method)
                    if handler is None:
                        allowed = ", ".join(sorted(m.keys()))
                        return Response(
                            f"Method {method} not allowed",
                            status=405,
                            headers={"Allow": allowed},
                        )
                    return await handler(
                        request,
                        datasette=datasette,
                        scope=scope,
                        receive=receive,
                        send=send,
                    )

                return dispatcher

            result.append((path, _make_dispatcher(dict(method_map))))

    return result


@hookimpl
def extra_template_vars(datasette):
    return {
        "datasette_paper_vite_entry": vite_entry(
            datasette=datasette,
            plugin_package="datasette_paper",
        ),
    }


# The doc page is the only paper page that hosts <datasette-acl-share-dialog>, so
# the share bundle is included there (opt-in) rather than site-wide. Matches
# ``/-/paper/doc/<id>`` exactly — not the index or any API route.
_DOC_PAGE_RE = re.compile(r"^/-/paper/doc/\d+$")


def _is_doc_page(request) -> bool:
    return bool(request and _DOC_PAGE_RE.match(request.path or ""))


@hookimpl
def extra_js_urls(datasette, request):
    """Include the <datasette-acl-share-dialog> JS bundle on the doc page only."""
    if not _is_doc_page(request):
        return []
    return _share_assets(datasette)["js"]


@hookimpl
def extra_css_urls(datasette, request):
    """Include the <datasette-acl-share-dialog> CSS on the doc page only."""
    if not _is_doc_page(request):
        return []
    return _share_assets(datasette)["css"]


_EVENTS_PATTERN = r"^/-/paper/api/docs/(?P<doc_id>\d+)/events$"


@hookimpl
def register_routes():
    routes_list = _method_dispatch_routes(router._routes)

    # The SSE GET handler uses raw ASGI (needs send/receive) and cannot go
    # through the decorator router.  Merge it into the existing POST dispatcher
    # for the same path so GET → sse_events and POST → post_events both work.
    def _make_events_dispatcher(post_view, get_view):
        async def events_dispatcher(
            request, datasette=None, scope=None, receive=None, send=None
        ):
            if request.method.upper() == "GET":
                return await get_view(
                    datasette=datasette,
                    request=request,
                    send=send,
                    receive=receive,
                )
            return await post_view(
                request,
                datasette=datasette,
                scope=scope,
                receive=receive,
                send=send,
            )

        return events_dispatcher

    return [
        (pattern, _make_events_dispatcher(view_fn, sse_events))
        if pattern == _EVENTS_PATTERN
        else (pattern, view_fn)
        for pattern, view_fn in routes_list
    ]


@hookimpl
def register_actions(datasette):
    return [
        # --- Global action --------------------------------------------------
        # Creating papers is the one coarse capability paper still gates on a
        # global permission. Listing/reading is no longer gated globally: the
        # index, list, search and template-param endpoints are reachable by
        # anyone and return only the docs acl says the actor can view.
        Action(
            name="datasette-paper-create",
            description="Can create new papers",
        ),
        # --- acl-backed resource actions ------------------------------------
        # These resolve against datasette-acl grants on PaperDocResource. Every
        # per-doc permission check goes through these; paper no longer ships
        # owner/shared/visibility SQL (only the `locked` deny in permissions.py).
        Action(
            name=PAPER_VIEW,
            description="View a paper doc",
            resource_class=PaperDocResource,
        ),
        Action(
            name=PAPER_EDIT,
            description="Edit a paper doc",
            resource_class=PaperDocResource,
            also_requires=PAPER_VIEW,
        ),
        Action(
            name=PAPER_MANAGE,
            description="Manage sharing for a paper doc",
            resource_class=PaperDocResource,
            also_requires=PAPER_VIEW,
        ),
    ]


@hookimpl
def datasette_acl_roles(datasette):
    """Friendly Viewer / Editor / Manager roles for the ``paper-doc`` type.

    Consumed by datasette-acl's role registry (see ``build_roles_registry``).
    Uses acl's ``standard_roles`` factory for the canonical cumulative triple
    (Viewer ⊂ Editor ⊂ Manager, ``manage=True`` on Manager).
    """
    return standard_roles(
        PAPER_DOC_RESOURCE_TYPE,
        view=PAPER_VIEW,
        edit=PAPER_EDIT,
        manage=PAPER_MANAGE,
        descriptions={
            "Viewer": "Can view the doc",
            "Editor": "Can view and edit the doc",
            "Manager": "Can view, edit, and manage sharing",
        },
    )


@hookimpl
def menu_links(datasette):
    # Listing is no longer permission-gated, so the "Papers" link is shown to
    # everyone; the index itself only surfaces docs the actor can view.
    return [
        {
            "href": datasette.urls.path("/-/paper/"),
            "label": "Papers",
        }
    ]


@hookimpl
async def startup(datasette):
    from .migrations import ensure_migrations, migrate_shares_to_acl

    internal = datasette.get_internal_database()
    if getattr(internal, "is_temp_disk", False):
        # Datasette's default --internal is an ephemeral tempfile that
        # gets atexit-deleted. Paper data evaporates on every restart in
        # that mode — surface a one-time warning so users persist their
        # internal DB on purpose, not by accident.
        logger.warning(
            "datasette-paper: internal DB is ephemeral (default --internal "
            "is a tempfile that gets deleted on exit). Papers will not "
            "persist across restarts. Pass --internal <path> to retain papers."
        )
    await ensure_migrations(internal)
    # One-time backfill of legacy visibility/share rows into acl grants. Runs
    # after the schema migrations (it reads _datasette_paper_doc /
    # _datasette_paper_share) and is guarded by its own marker so it's a no-op
    # on every startup after the first. Safe when acl isn't installed.
    await migrate_shares_to_acl(datasette)


# bootstrap-icons / file-text-fill — kept in sync with the icon used in
# DocHeader.svelte to the left of the doc title. If you swap the icon,
# update both sites.
PAPER_ICON_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" '
    'fill="currentColor" class="bi bi-file-text-fill" viewBox="0 0 16 16">'
    '<path d="M12 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V2a2 2 '
    "0 0 0-2-2M5 4h6a.5.5 0 0 1 0 1H5a.5.5 0 0 1 0-1m-.5 2.5A.5.5 0 0 1 5 "
    "6h6a.5.5 0 0 1 0 1H5a.5.5 0 0 1-.5-.5M5 8h6a.5.5 0 0 1 0 1H5a.5.5 0 "
    '0 1 0-1m0 2h3a.5.5 0 0 1 0 1H5a.5.5 0 0 1 0-1"/></svg>'
)


# Optional integration with `datasette-sidebar` — if the package is
# installed, register a Papers entry. The try/except keeps the plugin
# import-clean when datasette-sidebar isn't present.
try:
    from datasette_sidebar.hookspecs import SidebarApp  # type: ignore[import-not-found]

    @hookimpl
    def datasette_sidebar_apps(datasette):
        return [
            SidebarApp(
                label="Papers",
                description="Collaborative documents",
                href=lambda _db: "/-/paper/",
                icon=PAPER_ICON_SVG,
                color="#276890",
            )
        ]
except ImportError:
    pass


# Optional integration with `datasette-agent` — expose create/read/append/
# edit/insert tools to the LLM agent. Importing `AgentTool` is the guard:
# when datasette-agent isn't installed, the hook simply isn't registered.
try:
    from datasette_agent.tools import AgentTool  # type: ignore[import-not-found]  # noqa: F401

    @hookimpl
    def register_agent_tools(datasette):
        from .agent_tools import get_paper_agent_tools

        return get_paper_agent_tools()
except ImportError:
    pass
