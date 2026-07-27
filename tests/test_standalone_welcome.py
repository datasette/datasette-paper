"""Tests for the first-launch welcome doc (ticket 03 of ``plans/cli-top``).

Two concerns: the shipped ``cli/welcome.md`` package data must stay inside
the markdown schema lock-step (parses cleanly and round-trips through the
serializer), and ``_seed_welcome_doc`` must create a doc indistinguishable
from a hand-created one — owned by the launch actor, reindexed the same way
``create_doc`` reindexes any other markdown-seeded doc.

CLI-level seed-vs-no-seed behavior (whether ``launch()`` calls this at all)
lives in ``test_standalone_cli.py``, alongside the rest of the launch-flow
smoke tests.
"""

# @feat cli-top: welcome-doc tests — markdown lock-step guard + seed-function
# behavior (owned doc, reindexed tag).

import pytest

from conftest import actor_cookie
from datasette_paper.cli.standalone import (
    WELCOME_DOC_NAME,
    _load_welcome_markdown,
    _seed_welcome_doc,
    build_instance,
)
from datasette_paper.markdown import doc_to_markdown
from datasette_paper.markdown_parser import markdown_to_doc


def test_welcome_markdown_roundtrips():
    """Guards the schema lock-step (CLAUDE.md rule 1): a future schema change
    that orphans a node `welcome.md` relies on fails here, at test time —
    not at first launch, in front of a real user."""
    md = _load_welcome_markdown()
    doc = markdown_to_doc(md)
    assert doc_to_markdown(doc) == md


@pytest.mark.asyncio
async def test_seed_welcome_doc_creates_owned_indexed_doc(tmp_path):
    ds = build_instance(
        internal_db_path=tmp_path / "internal.db",
        user_dbs=[],
        user_id="alice",
        secret="fixed-test-secret",
    )
    await ds.invoke_startup()

    doc_id = await _seed_welcome_doc(ds, user_id="alice")

    fetch = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}", cookies=actor_cookie(ds, "alice")
    )
    assert fetch.status_code == 200, fetch.text
    assert fetch.json()["permissions"]["isOwner"] is True

    listing = await ds.client.get(
        "/-/paper/api/docs", cookies=actor_cookie(ds, "alice")
    )
    assert listing.status_code == 200, listing.text
    docs_by_id = {d["id"]: d for d in listing.json()}
    assert docs_by_id[doc_id]["name"] == WELCOME_DOC_NAME
    assert docs_by_id[doc_id]["created_by"] == "alice"

    # seed_owner_manager_grant ran: a stranger has no grant on this doc.
    stranger = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}", cookies=actor_cookie(ds, "mallory")
    )
    assert stranger.status_code == 403

    # The snapshot-seeded reindex sweep ran: the body's `#welcome` inline tag
    # (and, by extension, the task/link indexes built alongside it in the
    # same `if seeded_from_snapshot:` block) is searchable without an edit.
    refs = await ds.client.get(
        "/-/paper/api/tags/welcome/refs", cookies=actor_cookie(ds, "alice")
    )
    assert refs.status_code == 200, refs.text
    assert [d["id"] for d in refs.json()["docs"]] == [doc_id]


@pytest.mark.asyncio
async def test_seed_welcome_doc_bad_content_raises_click_exception(
    tmp_path, monkeypatch
):
    """A broken welcome.md must fail the launch loudly (a ClickException the
    CLI can surface), not 500 later when a user's browser lands on it."""
    import datasette_paper.cli.standalone as standalone

    monkeypatch.setattr(
        standalone, "_load_welcome_markdown", lambda: {"not": "a string"}
    )

    ds = build_instance(
        internal_db_path=tmp_path / "internal.db",
        user_dbs=[],
        user_id="alice",
        secret="fixed-test-secret",
    )
    await ds.invoke_startup()

    import click

    with pytest.raises(click.ClickException):
        await _seed_welcome_doc(ds, user_id="alice")
