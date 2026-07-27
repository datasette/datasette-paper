"""``datasette paper serve`` — launch a local, single-user paper instance.

    datasette paper serve [INTERNAL_DB] [-p PORT] [-h HOST] [-- DB...]

It builds a ``Datasette`` instance **in-process** (no subprocess), serves it
with uvicorn, and opens the browser on a one-time login URL that sets a
signed actor cookie for ``$USER`` and redirects to ``/-/paper/``.

The same command object is also the ``datasette-paper`` console script
(``[project.scripts] datasette-paper = "datasette_paper.cli.serve:serve"``)
— a pure alias, same flags, same behavior. The two entries differ in one
way that matters: the console script imports this package *before*
datasette, which trips the half-initialized-plugin scan that
:func:`_repair_plugin_registration` exists to repair; under
``datasette paper serve`` datasette is imported first and the repair is a
natural no-op.

Import-light like the rest of ``cli/`` — ``datasette``/``uvicorn`` are
late-imported inside function bodies — with one documented exception:
``hookimpl`` is needed at class-body evaluation time for
:class:`LocalLoginPlugin`'s decorator. Harmless in the plugin-load path:
importing it just re-imports the already-loaded ``datasette`` package.

See ``plans/cli-top/README.md`` for the full design/decisions table.
"""

import getpass
import secrets
from pathlib import Path

import click
from datasette import hookimpl


#: Where the successful login redirects by default (ticket 03 points a
#: first-launch redirect at the freshly seeded welcome doc instead).
DEFAULT_NEXT_PATH = "/-/paper/"

#: ``ds_actor`` cookies signed by :class:`LocalLoginPlugin` outlive the
#: browser session so a relaunch (persisted secret + stable actor id)
#: doesn't silently drop back to anonymous.
COOKIE_EXPIRE_AFTER = 30 * 24 * 3600

DEFAULT_PORT = 8001
DEFAULT_HOST = "127.0.0.1"


# @feat cli-top: one-off local-login plugin, registered only on the
# serve command's own Datasette instance — validates the launch token,
# sets a signed $USER actor cookie, and redirects to next_path.
class LocalLoginPlugin:
    """One-off auth plugin, registered programmatically per launch.

    Never ships as part of the ``datasette-paper`` plugin proper — real
    deployments are untouched. Adds a single route,
    ``GET /-/paper-local-login?token=<t>``: a correct token sets a signed
    ``ds_actor`` cookie for ``user_id`` and redirects to ``next_path``; a
    wrong or missing token raises ``Forbidden`` (403). The token is valid
    for the process lifetime (not single-use — this is a loopback instance,
    and the login URL is also printed to the terminal so a closed browser
    tab can get back in).
    """

    def __init__(self, user_id, token, next_path=DEFAULT_NEXT_PATH):
        # next_path must be same-origin (starts with "/", not "//") and is
        # never taken from the request — it's fixed at construction time (or
        # by the CLI mutating .next_path after a first-launch welcome-doc
        # seed; see `launch()`). `register_routes` re-reads `self.next_path`
        # on every call (Datasette recomputes routes per `ds.app()`), so a
        # post-construction mutation is picked up before uvicorn ever serves
        # a request.
        if (
            not isinstance(next_path, str)
            or not next_path.startswith("/")
            or next_path.startswith("//")
        ):
            raise ValueError(
                f"next_path must be a same-origin path starting with '/': {next_path!r}"
            )
        self.user_id = user_id
        self.token = token
        self.next_path = next_path

    @hookimpl
    def register_routes(self):
        # Datasette's route dispatch (`wrap_view`) only accepts a plain
        # function or a class for the view — a *bound method* fails an
        # isinstance check there. Close over `self` in a nested function
        # instead of handing over the bound method directly.
        user_id = self.user_id
        token = self.token
        next_path = self.next_path

        async def login(request, datasette):
            from datasette import Forbidden, Response

            request_token = request.args.get("token") or ""
            if not secrets.compare_digest(request_token, token):
                raise Forbidden("Invalid or missing login token")
            response = Response.redirect(next_path)
            datasette.set_actor_cookie(
                response, {"id": user_id}, expire_after=COOKIE_EXPIRE_AFTER
            )
            return response

        return [(r"^/-/paper-local-login$", login)]


def get_actor_id() -> str:
    """``$USER`` via ``getpass.getuser()``, falling back to ``"local"``.

    ``getpass.getuser()`` can raise on exotic environments (no controlling
    tty, unset env vars) — never let that take down the launcher.
    """
    try:
        return getpass.getuser()
    except Exception:
        return "local"


def datasette_home_dir() -> Path:
    """``~/.datasette`` — shared parent for the default internal db + secret."""
    return Path.home() / ".datasette"


def default_internal_db_path() -> Path:
    return datasette_home_dir() / "internal-paper.db"


def secret_path() -> Path:
    return datasette_home_dir() / "internal-paper.secret"


def load_or_create_secret() -> str:
    """Read the persisted Datasette secret, creating it (mode 0600) if absent.

    Persisting it keeps signed ``ds_actor`` cookies valid across relaunches
    — an open tab reconnects after a relaunch instead of silently going
    anonymous.
    """
    path = secret_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return path.read_text().strip()
    secret = secrets.token_hex(32)
    path.write_text(secret)
    path.chmod(0o600)
    return secret


def build_instance(*, internal_db_path, user_dbs=None, user_id, secret):
    """Compose the ``Datasette`` instance the CLI serves.

    A pure-ish factory, unit-testable without uvicorn: ``datasette-paper-create``
    is config-gated to ``user_id`` only (anonymous requests can't create);
    everything else (per-doc view/edit/manage) flows through acl grants for
    ``user_id`` as usual. ``profile_access`` is deliberately not granted —
    paper degrades to id-as-name (docs/PERMISSIONS.md §14).
    """
    from datasette.app import Datasette

    config = {
        "permissions": {
            "datasette-paper-create": {"id": user_id},
        }
    }
    return Datasette(
        files=list(user_dbs or []),
        internal=str(internal_db_path),
        config=config,
        secret=secret,
    )


# ---------------------------------------------------------------------------
# `--` splitting — pure, unit-tested apart from click.
# ---------------------------------------------------------------------------


def split_argv(argv):
    """Split *argv* on the first literal ``"--"``: ``(ours, user_dbs)``.

    Must run **before** click parses: click merges positionals across
    ``--``, so with a naive ``[INTERNAL_DB] [DBS]...`` signature,
    ``datasette-paper -- a.db b.db`` would wrongly bind ``a.db`` as the
    internal db. A second literal ``--`` (if any) stays in the user-db
    list untouched — only the *first* one is the split point.
    """
    argv = list(argv)
    if "--" in argv:
        idx = argv.index("--")
        return argv[:idx], argv[idx + 1 :]
    return argv, []


class _ServeCommand(click.Command):
    """Intercepts ``--`` before click's own argument parsing runs.

    ``parse_args`` is the one hook that sees the raw argv click was
    invoked with, before it does anything with it — perfect place to peel
    off ``user_dbs`` and stash them on ``ctx.obj`` for the callback,
    leaving click to parse only ``ours``.
    """

    def parse_args(self, ctx, args):
        ours, user_dbs = split_argv(args)
        ctx.obj = {"user_dbs": user_dbs}
        return super().parse_args(ctx, ours)

    def collect_usage_pieces(self, ctx):
        # The `[-- DB...]` tail never reaches click (see parse_args above),
        # so it won't show up in the auto-generated usage line on its own.
        pieces = super().collect_usage_pieces(ctx)
        pieces.append("[-- DB...]")
        return pieces


# ---------------------------------------------------------------------------
# Launch flow
# ---------------------------------------------------------------------------


def _preexisting_db_warning(all_doc_ids, viewable_ids, *, user_id, internal_db_path):
    """Return the warning string, or ``None`` if nothing's amiss.

    Warn-and-continue only: docs exist but zero are viewable by the launch
    actor. Partial visibility (some docs viewable) stays silent — that's
    the expected, boring case of sharing a db across machines for the same
    actor id.
    """
    if not all_doc_ids or viewable_ids:
        return None
    return (
        f"Warning: this database has {len(all_doc_ids)} docs but none are "
        f"visible to actor '{user_id}' — grants in it are keyed to other "
        "actor ids (it likely came from another datasette-paper instance). "
        "The server will look empty. To read content regardless of grants: "
        f"`datasette paper list {internal_db_path}` / "
        f"`datasette paper dump {internal_db_path} <dir>`."
    )


async def _check_preexisting_db(ds, *, user_id, internal_db_path):
    """The pre-existing-db warning check proper (ticket 02 step 4).

    Only called by :func:`launch` when the internal db file already existed
    before this launch — a brand-new db has no docs, so the caller skips
    this entirely rather than running a query that can only ever come back
    empty. Kept separate from ``invoke_startup`` (which always runs, and
    itself may touch doc-related tables via unrelated one-time backfills)
    so the two are independently testable.
    """
    from datasette_paper.db import PaperDB
    from datasette_paper.permissions import viewable_doc_ids

    db = PaperDB(ds.get_internal_database())
    all_ids = await db.all_doc_ids()
    if not all_ids:
        return None
    viewable_ids = await viewable_doc_ids(ds, {"id": user_id})
    return _preexisting_db_warning(
        all_ids, viewable_ids, user_id=user_id, internal_db_path=internal_db_path
    )


#: Name of the first-launch welcome doc, seeded via the real create route.
WELCOME_DOC_NAME = "Welcome to datasette-paper"


def _load_welcome_markdown() -> str:
    """Read the shipped ``cli/welcome.md`` package-data file.

    ``importlib.resources`` (not a bare ``Path(__file__).parent / "..."``
    read) so the file is found whether the package is installed from a
    wheel/sdist or run from a checkout — see the
    ``[tool.setuptools.package-data]`` entry in ``pyproject.toml``.
    """
    from importlib import resources

    return resources.files("datasette_paper.cli").joinpath("welcome.md").read_text()


# @feat cli-top: first-launch welcome doc — seeded through the real
# `POST /-/paper/api/docs` create route (no duplicated create logic: the
# route itself does markdown_to_doc, the version-0 snapshot insert, the
# reindex sweep, and the owner Manager-grant seeding), authenticated as the
# launch actor via a signed ds_actor cookie.
async def _seed_welcome_doc(ds, *, user_id) -> int:
    """POST the welcome markdown through the create route; return the doc id.

    Deliberately does not reimplement any create-route logic — a plain
    authenticated POST gets the same markdown_to_doc parse, version-0
    snapshot, reindex sweep, and owner-grant seeding as a hand-created doc.
    Raises ``click.ClickException`` (message includes the response body) on
    anything but 201, so a broken ``welcome.md`` fails the launch loudly
    instead of quietly 500ing later in the browser.
    """
    cookie = ds.sign({"a": {"id": user_id}}, "actor")
    resp = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": WELCOME_DOC_NAME, "content": _load_welcome_markdown()},
        cookies={"ds_actor": cookie},
    )
    if resp.status_code != 201:
        raise click.ClickException(
            f"Failed to seed the welcome doc ({resp.status_code}): {resp.text}"
        )
    return resp.json()["id"]


# @feat cli-top: registration repair for the console-script import order —
# without it the launched instance has no paper routes or migrations at all,
# and dependencies caught in the same import cycle (datasette-user-profiles)
# lose their actions/startup too.
def _repair_plugin_registration():
    """Re-register every plugin module pluggy scanned while half-initialized.

    The console script imports ``datasette_paper.cli.serve`` first, so
    Python begins executing ``datasette_paper/__init__`` — whose import chain
    reaches ``datasette.plugins``, which loads entry points *during* that
    import. Any plugin module that is mid-import at that moment comes out of
    ``sys.modules`` half-initialized, and pluggy scans it for hookimpls
    before they're defined: the plugin ends up registered with zero hooks.
    That's ``datasette_paper`` itself (no routes → 404s, no ``startup`` → no
    migrations → "no such table: _datasette_paper_doc") **and** dependencies
    its chain imports directly — ``datasette_user_profiles`` (imported for
    ``resolve_profile_actors``) loses ``register_actions`` ("Unknown action:
    profile_access") and its table-creating ``startup``. Every other entry
    into the package (``datasette`` CLI, pytest) imports datasette first and
    never hits this.

    By the time ``launch()`` runs, every module is fully imported — so any
    registered module plugin with zero hookimpls on file is either a
    mid-import casualty or genuinely hookless, and re-registering is the
    correct repair for the former and a no-op for the latter.
    """
    import types

    from datasette.plugins import pm

    for plugin in list(pm.get_plugins()):
        if not isinstance(plugin, types.ModuleType):
            continue
        if pm.get_hookcallers(plugin):
            continue
        name = pm.get_name(plugin)
        pm.unregister(plugin)
        pm.register(plugin, name=name)


def _validate_user_dbs(user_dbs, *, ctx):
    for path in user_dbs:
        p = Path(path)
        if not p.is_file():
            raise click.UsageError(f"Database file not found: {path}", ctx=ctx)


def launch(*, internal_db, port, host, user_dbs, ctx=None):
    """The full launch flow, mirroring the tail of ``datasette.cli.serve``.

    Split out of the click callback so it stays testable independent of
    click's own arg parsing (the CLI smoke tests monkeypatch ``uvicorn.run``
    / ``webbrowser.open`` and call this indirectly via the ``main`` command).
    """
    from datasette.cli import run_sync
    from datasette.plugins import pm

    _repair_plugin_registration()
    _validate_user_dbs(user_dbs, ctx=ctx)

    internal_db_path = (
        Path(internal_db).expanduser() if internal_db else (default_internal_db_path())
    )
    internal_db_path.parent.mkdir(parents=True, exist_ok=True)
    db_existed_before = internal_db_path.exists()

    user_id = get_actor_id()
    secret = load_or_create_secret()
    token = secrets.token_urlsafe()

    ds = build_instance(
        internal_db_path=internal_db_path,
        user_dbs=user_dbs,
        user_id=user_id,
        secret=secret,
    )
    login_plugin = LocalLoginPlugin(user_id, token)
    pm.register(login_plugin, name="paper-local-login")

    run_sync(ds.invoke_startup)

    warning = None
    if db_existed_before:
        warning = run_sync(
            lambda: _check_preexisting_db(
                ds, user_id=user_id, internal_db_path=internal_db_path
            )
        )
    else:
        # First launch (the internal db file didn't exist when we resolved
        # it above — NOT "zero docs", so deleting the welcome doc later
        # never resurrects it): seed it and point this launch's login
        # redirect at it instead of the doc index. `register_routes` reads
        # `login_plugin.next_path` fresh on every `ds.app()` call, so this
        # mutation lands before uvicorn ever serves a request.
        doc_id = run_sync(lambda: _seed_welcome_doc(ds, user_id=user_id))
        login_plugin.next_path = f"/-/paper/doc/{doc_id}"
    if warning:
        click.echo(warning)

    login_url = f"http://{host}:{port}/-/paper-local-login?token={token}"
    click.echo(f"Log in at: {login_url}")

    import webbrowser

    webbrowser.open(login_url)

    import uvicorn

    uvicorn.run(
        ds.app(), host=host, port=port, log_level="info", lifespan="on", workers=1
    )


# @feat cli-top: the `datasette paper serve` command (also the
# `datasette-paper` console script via [project.scripts]) — click command
# entry point (`[project.scripts] datasette-paper`), splits `sys.argv` on
# a literal `--` before click parses so extra positionals never collide
# with the optional INTERNAL_DB argument.
@click.command(
    cls=_ServeCommand,
    context_settings={"max_content_width": 100},
)
@click.argument(
    "internal_db",
    required=False,
    type=click.Path(dir_okay=False),
)
@click.option(
    "-p",
    "--port",
    default=DEFAULT_PORT,
    show_default=True,
    help="Port to serve on.",
)
@click.option(
    "-h",
    "--host",
    default=DEFAULT_HOST,
    show_default=True,
    help="Host to bind to. Non-loopback is an explicit opt-in — remote "
    "visitors stay anonymous (cookie auth), no extra guard needed.",
)
@click.pass_context
def serve(ctx, internal_db, port, host):
    """Launch a local, single-user datasette-paper instance.

    Builds a Datasette instance in-process, serves it with uvicorn, and
    opens the browser on a one-time login URL that signs you in as
    $USER and redirects to /-/paper/.

    Extra database files to serve alongside go after a literal `--`:

        datasette-paper -- mydata.db

    \b
    Warnings:
    - Don't point this at the internal db of a currently running
      instance — SQLite write locks plus split-brain in-memory state
      (SSE is per-process).
    - Opening a db migrates it: paper's and datasette-acl's startup
      migrations write to the file on launch, even if you never edit a
      doc. Copying it back to an older deployment after a local peek
      hands that deployment a forward-migrated schema.
    """
    user_dbs = (ctx.obj or {}).get("user_dbs", [])
    launch(internal_db=internal_db, port=port, host=host, user_dbs=user_dbs, ctx=ctx)


if __name__ == "__main__":  # pragma: no cover
    serve()
