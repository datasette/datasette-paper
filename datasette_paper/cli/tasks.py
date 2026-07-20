"""``datasette paper tasks`` — a doc's task_items, the offline twin of ``GET /tasks``."""

import click

from ._common import open_db


def _tasks_checklist(doc_tasks):
    """Render `extract_tasks` output as a `- [ ]`/`- [x]` checklist string.

    Two-space indent per `depth`; ignores `section`/assignees/due (the JSON
    format carries those). Ends with a trailing newline, empty string if
    there are no tasks.
    """
    lines = [
        "  " * task["depth"] + f"- [{'x' if task['checked'] else ' '}] {task['text']}"
        for task in doc_tasks
    ]
    return "\n".join(lines) + ("\n" if lines else "")


# @feat cli-tasks: register the `datasette paper tasks` CLI command
@click.command()
@click.argument("internal_db", type=click.Path(exists=True, dir_okay=False))
@click.argument("doc_id", type=int, required=False, default=None)
@click.option(
    "-f",
    "--format",
    "fmt",
    type=click.Choice(["json", "markdown"]),
    default="json",
    show_default=True,
    help="Output format",
)
def tasks(internal_db, doc_id, fmt):
    """Print a doc's task_items to stdout — the offline twin of GET /tasks.

    INTERNAL_DB is the internal database this Datasette runs with
    (`datasette --internal <path>`). DOC_ID is the numeric id from the
    doc's URL; when omitted, every active, kind='doc' doc is swept (the
    same scoping the profile TODOs page uses). Read-only: safe to run
    against a file a live Datasette is currently serving.
    """
    import json as json_module

    from ..export import ExportError, load_live_doc
    from ..markdown import extract_tasks
    from ..sql import _queries

    with open_db(internal_db) as conn:
        if doc_id is not None:
            doc_tasks = extract_tasks(load_live_doc(conn, doc_id))
        else:
            # @feat cli-tasks: sweep every active, kind='doc' doc — same
            # scoping as the profile TODOs page, applied in Python since
            # list_docs has no state/kind filter of its own.
            docs = [
                doc
                for doc in _queries.list_docs(conn)
                if doc.state == "active" and doc.kind == "doc"
            ]
            entries = []
            for doc in docs:
                try:
                    doc_result = extract_tasks(load_live_doc(conn, doc.id))
                except ExportError as exc:
                    # Fail closed: a corrupt doc aborts the whole run
                    # rather than silently dropping its tasks.
                    raise ExportError(f"doc {doc.id} ({doc.name!r}): {exc}") from exc
                if doc_result:  # zero-task docs excluded from the sweep
                    entries.append((doc, doc_result))

    if fmt == "json":
        if doc_id is not None:
            click.echo(json_module.dumps(doc_tasks, indent=2))
        else:
            click.echo(
                json_module.dumps(
                    [
                        {"doc_id": doc.id, "doc_name": doc.name, "tasks": doc_tasks}
                        for doc, doc_tasks in entries
                    ],
                    indent=2,
                )
            )
        return

    # markdown
    if doc_id is not None:
        click.echo(_tasks_checklist(doc_tasks), nl=False)
        return
    blocks = []
    for doc, doc_tasks in entries:
        checklist = _tasks_checklist(doc_tasks).rstrip("\n")
        blocks.append(f"## {doc.name}\n\n{checklist}")
    click.echo("\n\n".join(blocks) + ("\n" if blocks else ""), nl=False)
