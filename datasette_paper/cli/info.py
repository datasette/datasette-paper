"""``datasette paper info`` — one doc's row + history stats, no materializing."""

import click

from ._common import open_db


# @feat cli-info: register the `datasette paper info` CLI command
@click.command()
@click.argument("internal_db", type=click.Path(exists=True, dir_okay=False))
@click.argument("doc_id", type=int)
@click.option(
    "--json", "as_json", is_flag=True, help="Emit the report as one JSON object."
)
def info(internal_db, doc_id, as_json):
    """Print one paper doc's row + history stats — no server, no materializing.

    INTERNAL_DB is the internal database this Datasette runs with
    (`datasette --internal <path>`). DOC_ID is the numeric id from the
    doc's URL. Read-only: safe to run against a file a live Datasette is
    currently serving. Unlike `export`, this never loads prosemirror-py —
    it reports snapshot version, step-tail length, and total row counts
    straight from the generated query helpers, without folding the doc.
    """
    from ..export import ExportError
    from ..sql import _queries

    with open_db(internal_db) as conn:
        # One BEGIN across all reads, same shape as export.load_live_doc:
        # pins a single database snapshot so a concurrent compacting
        # writer can't hand us a torn view across the doc/snapshot/step
        # queries below.
        conn.execute("BEGIN")
        try:
            doc = _queries.select_doc_by_id(conn, doc_id=doc_id)
            if doc is None:
                raise ExportError(f"No paper doc with id {doc_id}")
            snapshot = _queries.select_latest_snapshot(conn, doc_id=doc_id)
            snapshot_version = snapshot.version if snapshot else 0
            tail = _queries.select_steps_after(
                conn, doc_id=doc_id, after_version=snapshot_version
            )
            total_steps = _queries.count_steps_for_doc(conn, doc_id=doc_id)
            total_snapshots = _queries.count_snapshots_for_doc(conn, doc_id=doc_id)
        finally:
            conn.execute("ROLLBACK")

    history_version = tail[-1].version if tail else snapshot_version
    incomplete = history_version != doc.current_version

    report = {
        "id": doc.id,
        "name": doc.name,
        "state": doc.state,
        "kind": doc.kind,
        "created_at": doc.created_at,
        "updated_at": doc.updated_at,
        "created_by": doc.created_by,
        "current_version": doc.current_version,
        "locked": bool(doc.locked),
        "snapshot_version": snapshot.version if snapshot else None,
        "snapshot_created_at": snapshot.created_at if snapshot else None,
        "history_version": history_version,
        "tail_steps": len(tail),
        "total_steps": total_steps,
        "total_snapshots": total_snapshots,
        "incomplete_history": incomplete,
    }
    for extra in ("archived_at", "trashed_at", "delete_at"):
        value = getattr(doc, extra)
        if value is not None:
            report[extra] = value

    if as_json:
        import json as json_module

        click.echo(json_module.dumps(report, indent=2))
        return

    click.echo(f"name: {doc.name}")
    click.echo(f"state: {doc.state}")
    click.echo(f"kind: {doc.kind}")
    click.echo(f"created: {doc.created_at}")
    click.echo(f"updated: {doc.updated_at}")
    click.echo(f"created_by: {doc.created_by}")
    click.echo(f"version: {doc.current_version}")
    click.echo(f"locked: {bool(doc.locked)}")
    if snapshot is None:
        click.echo("snapshot: none")
    else:
        click.echo(
            f"snapshot: version {snapshot.version} (created {snapshot.created_at})"
        )
    click.echo(f"history reaches: {history_version}")
    click.echo(f"tail steps: {len(tail)}")
    click.echo(f"total steps: {total_steps}")
    click.echo(f"total snapshots: {total_snapshots}")
    for extra in ("archived_at", "trashed_at", "delete_at"):
        value = getattr(doc, extra)
        if value is not None:
            click.echo(f"{extra}: {value}")
    if incomplete:
        click.echo(
            f"WARNING: incomplete history — history reaches {history_version} but"
            f" doc is at version {doc.current_version} — run paper check"
        )
