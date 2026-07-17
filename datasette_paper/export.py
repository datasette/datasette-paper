"""Standalone doc export — the Python API behind ``datasette paper export``.

Reads a paper doc straight from a Datasette internal database *file*, with
no running server: the latest snapshot plus the step tail after it, folded
through the same prosemirror-py schema the live materializer uses. This is
the cache-free, offline twin of ``Instance.materialize_live_doc`` with one
deliberate difference: where the live path degrades to the last good
version on a bad step (serving must go on), export raises ``ExportError``
— a partial export would silently lose content. To that end the history is
also *validated*, not just folded: step versions must be contiguous from
the snapshot, and the final version must equal the doc row's
``current_version`` (see :func:`load_live_doc`).

Read-only by design: :func:`open_internal_db` opens with ``mode=ro``, so
pointing it at an internal.db a live Datasette is currently serving is safe
(the single-writer rule only bites writers). All reads for one export run
inside a single read transaction, so a concurrent writer — e.g. the live
server compacting the doc (new snapshot + deleting folded steps) between
our snapshot and step queries — can't hand us a torn view.
"""

import json
import sqlite3
from pathlib import Path
from typing import Sequence
from urllib.parse import quote

from .markdown import doc_to_markdown
from .sql import _queries
from .util import empty_doc_json


class ExportError(Exception):
    """A doc could not be exported (missing, wrong file, corrupt history)."""


def open_internal_db(path: str) -> sqlite3.Connection:
    """Open an internal database file read-only, validating it holds papers.

    Raises ``ExportError`` if the file isn't a paper-bearing internal db —
    a fresh sqlite file would otherwise surface as a confusing
    ``no such table`` error from the first query.
    """
    # mode=ro requires the URI form, and the URI form makes `?`, `#` and
    # `%` in the filename significant — percent-encode the (absolute) path
    # so such names open the intended file. `/` must stay raw.
    uri = "file:" + quote(str(Path(path).resolve()), safe="/") + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table'"
            " AND name = '_datasette_paper_doc'"
        ).fetchone()
    except sqlite3.Error as exc:
        raise ExportError(f"Cannot open {path!r} read-only: {exc}") from exc
    if row is None:
        conn.close()
        raise ExportError(
            f"{path!r} has no paper tables — is it the internal database"
            " this Datasette was started with (`datasette --internal <path>`)?"
        )
    return conn


# @feat cli-export: snapshot + step-tail fold (offline twin of Instance.materialize_live_doc)
def materialize(
    snapshot_doc_json: str, snapshot_version: int, steps: Sequence[_queries.Step]
) -> dict:
    """Fold a snapshot and its step tail into the live doc JSON dict.

    ``steps`` are the stored step records (their ``version`` fields are
    load-bearing): each must be exactly one past the previous — a gap means
    rows are missing and the fold would silently skip history, so it raises
    ``ExportError`` instead. Parse/apply failures also raise, naming the
    stored (database) version of the offending step.
    """
    # Late imports mirror instance.py — keep prosemirror off the cold path.
    from prosemirror.transform import Step

    from .pm_schema import schema

    try:
        doc = schema.node_from_json(json.loads(snapshot_doc_json))
    except Exception as exc:
        raise ExportError(
            f"Snapshot at version {snapshot_version} failed to parse: {exc}"
        ) from exc

    expected = snapshot_version
    for record in steps:
        expected += 1
        if record.version != expected:
            raise ExportError(
                "Step history is not contiguous: expected version"
                f" {expected} after the version-{snapshot_version} snapshot,"
                f" found version {record.version}"
            )
        try:
            step = Step.from_json(schema, json.loads(record.step_json))
            result = step.apply(doc)
        except Exception as exc:
            raise ExportError(f"Step version {record.version} raised: {exc}") from exc
        if result.failed:
            raise ExportError(
                f"Step version {record.version} failed to apply: {result.failed}"
            )
        doc = result.doc
    return doc.to_json()


def load_live_doc(conn: sqlite3.Connection, doc_id: int) -> dict:
    """Return the live ProseMirror doc JSON for ``doc_id``.

    Raises ``ExportError`` if the doc doesn't exist, its stored history is
    incomplete (gaps, or a tail that doesn't reach the doc row's
    ``current_version``), or it can't be materialized.
    """
    # One BEGIN across all three reads: the first SELECT pins a single
    # database snapshot, so a live server's concurrent compaction (insert
    # snapshot + delete folded steps) can't land between our snapshot and
    # step queries and hand us a stale-but-plausible doc. Read-only conn,
    # so the transaction can never write; ROLLBACK just releases it.
    try:
        conn.execute("BEGIN")
        try:
            doc = _queries.select_doc_by_id(conn, doc_id=doc_id)
            if doc is None:
                raise ExportError(f"No paper doc with id {doc_id}")
            snapshot = _queries.select_latest_snapshot(conn, doc_id=doc_id)
            snapshot_version = snapshot.version if snapshot else 0
            steps = _queries.select_steps_after(
                conn, doc_id=doc_id, after_version=snapshot_version
            )
        finally:
            conn.execute("ROLLBACK")
    except sqlite3.OperationalError as exc:
        # The paper tables exist but don't match this plugin version's
        # schema — a live internal.db would have been migrated at startup,
        # so this file predates a migration (or isn't really a paper db).
        raise ExportError(
            f"Paper schema mismatch ({exc}) — this file was not created by"
            " the running datasette-paper version. Serve it once so"
            " migrations bring it current."
        ) from exc

    if snapshot is None:
        snapshot_doc_json = json.dumps(empty_doc_json())
    else:
        snapshot_doc_json = snapshot.doc_json

    # Fail closed on a truncated tail: the doc row says how far history
    # goes; if the stored steps don't reach it, rows are missing and a
    # "successful" export would silently drop the newest edits.
    stored_version = steps[-1].version if steps else snapshot_version
    if stored_version != doc.current_version:
        raise ExportError(
            f"Incomplete step history: doc {doc_id} is at version"
            f" {doc.current_version} but the stored snapshot + steps only"
            f" reach version {stored_version}"
        )

    return materialize(snapshot_doc_json, snapshot_version, steps)


def export_markdown(conn: sqlite3.Connection, doc_id: int) -> str:
    """Return the doc's markdown (newline-terminated).

    No resolver/actor-name context — inline refs serialize in their
    canonical ``paper:/`` form, byte-matching the client serializer (the
    contract the fixtures/markdown golden suite pins).
    """
    return doc_to_markdown(load_live_doc(conn, doc_id))
