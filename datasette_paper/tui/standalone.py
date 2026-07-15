"""Standalone bootstrap: point the TUI at an internal.db with no running server.

Spins up an **in-process** Datasette and hands the client an
``httpx.ASGITransport`` — no network, no port. ``PaperClient`` already takes an
injectable transport (that's how every TUI test runs), so the client layer is
unchanged; this module is pure bootstrap and imports no textual.

This does NOT violate the "never open the internal DB directly" rule
(plans/tui/01-architecture.md): the in-process Datasette runs the real plugin,
so every write still flows through one ``Instance`` registry with its write
lock. The rule it must respect instead is **one process at a time** — two
servers on the same internal.db means two registries and step-log corruption.
:func:`_probe_single_writer` enforces that with a brief exclusive-write probe.

@feat tui: standalone bootstrap — in-process Datasette over ASGITransport
"""

from __future__ import annotations

import os
import secrets
import sqlite3
from pathlib import Path
from typing import Optional

import httpx
from datasette.app import Datasette

from ..instance import MAX_STEP_BYTES
from .client import PaperClient


def default_actor_id() -> str:
    """Stable local actor id for edit attribution (``doc-activity``)."""
    return os.environ.get("USER") or "local"


def _has_url_scheme(target: str) -> bool:
    return target.startswith("http://") or target.startswith("https://")


# @feat tui: CLI target sniffing — URL vs internal.db path, with combo validation
def resolve_tui_target(
    target: str,
    *,
    internal: bool = False,
    token: Optional[str] = None,
    dbs=(),
) -> dict:
    """Decide whether *target* names a running server (URL mode) or an
    internal.db file (standalone mode), and validate the flag combination.

    Sniff: ``--internal`` forces path interpretation; otherwise an ``http(s)://``
    target is URL mode, and a scheme-less target is internal mode *if it looks
    like a database file* (it exists, or ends in ``.db``). A scheme-less target
    that is neither — ``localhost:8001``, a typo'd hostname — is rejected rather
    than silently becoming a fresh SQLite file in the working directory.

    Rejects nonsensical combinations with :class:`click.UsageError`: ``--token``
    only means anything for a server (URL mode), and ``--db`` attaches content
    files only in standalone mode. Pure and side-effect-free so it's unit-testable
    without booting the app.
    """
    import click

    dbs = list(dbs)
    is_internal = internal or not _has_url_scheme(target)
    if is_internal and not internal:
        looks_like_db = target.endswith(".db") or Path(target).exists()
        if not looks_like_db:
            raise click.UsageError(
                f"Ambiguous target {target!r}: not an http(s):// URL, and not an "
                "existing file or *.db path. Use a full URL for a running server, "
                "or --internal to force reading it as an internal database path."
            )
    if is_internal:
        if token:
            raise click.UsageError(
                "--token applies to a running server (URL mode); it cannot be "
                "combined with an internal database path."
            )
        return {"mode": "internal", "internal_path": target, "content_dbs": dbs}
    if dbs:
        raise click.UsageError(
            "--db attaches content databases in internal mode only; it has no "
            "effect against a running server (URL mode)."
        )
    return {"mode": "url", "url": target, "token": token}


def _probe_single_writer(internal_path: Path) -> None:
    """Refuse to serve an internal.db another process is already writing.

    Opens a raw connection and takes a ``BEGIN IMMEDIATE`` (reserved-lock)
    write transaction with a short busy timeout, then rolls back. A concurrently
    running Datasette holding a write transaction makes this fail with
    ``database is locked`` — which is exactly the version-race corruption we must
    prevent. A missing file is fine: the connect creates an empty db and the
    probe succeeds; migrations populate it at ``invoke_startup``.
    """
    # timeout is seconds; ~1s is enough to distinguish a momentary write from a
    # server sitting on the file.
    conn = sqlite3.connect(str(internal_path), timeout=1.0)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.rollback()
    except sqlite3.OperationalError as exc:
        raise RuntimeError(
            f"Cannot open {internal_path} for standalone editing: {exc}. "
            "Another process appears to be serving this internal database. "
            "Only one process may serve a given internal.db at a time "
            "(two writers corrupt the paper step log). Stop the other "
            "Datasette (or point --internal at its running server's URL instead)."
        ) from exc
    finally:
        conn.close()


async def standalone_client(
    internal_path,
    content_dbs: Optional[list] = None,
    actor_id: Optional[str] = None,
) -> PaperClient:
    """Boot an in-process Datasette on *internal_path* and return a client.

    *content_dbs* are extra SQLite files to attach (so ``sql_block`` / embeds /
    the browser have data to query). *actor_id* attributes edits; it defaults to
    ``$USER`` (or ``local``). Runs the real migrations via ``invoke_startup``
    before returning, so a fresh internal.db is created and populated on first
    use. The returned client talks to the app over ``ASGITransport`` and carries
    a signed ``ds_actor`` cookie for *actor_id*.

    Raises if the parent directory of *internal_path* does not exist, or if the
    file looks live (see :func:`_probe_single_writer`).
    """
    internal_path = Path(internal_path)
    content_dbs = list(content_dbs or [])
    actor_id = actor_id or default_actor_id()

    parent = internal_path.parent
    if not parent.is_dir():
        raise RuntimeError(
            f"Cannot create internal database {internal_path}: "
            f"the directory {parent} does not exist."
        )

    _probe_single_writer(internal_path)

    # Grant the local actor all four paper permissions. Standalone is a
    # single-user, single-process local tool, so the actor must reach every doc
    # in the file regardless of who created it (docs authored in the web UI
    # carry a different created_by). Same shape as tests/conftest.py's
    # make_datasette; the per-doc `locked` deny (permissions.py) still applies.
    config = {
        "permissions": {
            "datasette-paper-create": True,
            "paper-view": True,
            "paper-edit": True,
            "paper-manage": True,
        }
    }
    ds = Datasette(
        files=content_dbs,
        internal=str(internal_path),
        config=config,
        secret=secrets.token_hex(32),
        # Match conftest: the events API accepts steps up to MAX_STEP_BYTES, so
        # raise the framework POST-body cap above that.
        settings={"max_post_body_bytes": MAX_STEP_BYTES + 1024 * 1024},
    )
    await ds.invoke_startup()  # runs migrations

    cookie = ds.sign({"a": {"id": actor_id}}, "actor")
    return PaperClient(
        base_url="http://paper.internal",
        transport=httpx.ASGITransport(app=ds.app()),
        cookies={"ds_actor": cookie},
        # server_url stays None: there is no real browser URL in internal mode.
    )
