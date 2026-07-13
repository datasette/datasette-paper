"""Database operations for datasette-paper.

All operations run on Datasette's internal database. Papers are plugin
state, not user data — they live alongside Datasette's other internal
tables and are configured via ``datasette --internal <path>``.

The SQL itself lives in ``sql/queries.sql`` and is compiled into
``sql/_queries.py`` by ``just codegen-queries``. PaperDB is orchestration
only — multi-statement operations (``insert_step`` bumping the doc's
``current_version``) chain the generated helpers inside a single
``execute_write_fn`` closure so the transaction stays atomic.

Sharing is owned by datasette-acl now; paper keeps no share table or
``visibility`` column (both dropped in migration m004), so there are no
share read/write helpers here — the ``<datasette-acl-share-dialog>`` component
talks to the acl JSON API directly.
"""

from __future__ import annotations

import json
from typing import Optional

from .sql import _queries


class PaperDB:
    """Thin async wrapper around Datasette's internal ``Database``.

    Use ``util.paper_db(datasette)`` to construct one. Migrations run once
    at startup via the plugin's ``startup`` hook — there is no
    per-request migration step.
    """

    def __init__(self, database) -> None:
        self.database = database

    async def _exec(self, query_fn, **kwargs):
        """Run a single generated query inside one ``execute_write_fn`` closure.

        Collapses the boilerplate for the many single-statement passthroughs.
        Multi-statement operations (``insert_step``, ``replace_links``,
        ``set_doc_tags``, ``hard_delete_doc``, ``insert_doc_with_snapshot``)
        keep their explicit closures so the transaction stays atomic.
        """
        return await self.database.execute_write_fn(
            lambda conn: query_fn(conn, **kwargs)
        )

    # ------------------------------------------------------------------
    # Doc
    # ------------------------------------------------------------------

    async def insert_doc(
        self,
        *,
        name: str,
        created_by: Optional[str] = None,
        schema_name: str = "basic+list",
        kind: str = "doc",
    ) -> _queries.Doc:
        def write(conn):
            return _queries.insert_doc(
                conn,
                name=name,
                created_by=created_by,
                schema_name=schema_name,
                kind=kind,
            )

        doc = await self.database.execute_write_fn(write)
        assert doc is not None
        return doc

    async def insert_doc_with_snapshot(
        self,
        *,
        name: str,
        created_by: Optional[str] = None,
        schema_name: str = "basic+list",
        kind: str = "doc",
        snapshot_doc_json: str,
        snapshot_actor_id: Optional[str] = None,
    ) -> _queries.Doc:
        """Create a doc and seed it with a version-0 snapshot atomically.

        Used by create-from-template: the new doc's first hydrate
        reads the snapshot we plant here so the cloned content appears
        as the starting state with version=0. Running both inserts in
        one execute_write_fn closure keeps the doc from being briefly
        visible without a snapshot (which would make Instance.hydrate
        fall back to the empty-doc JSON).
        """

        def write(conn):
            doc = _queries.insert_doc(
                conn,
                name=name,
                created_by=created_by,
                schema_name=schema_name,
                kind=kind,
            )
            assert doc is not None
            _queries.insert_snapshot(
                conn,
                doc_id=doc.id,
                version=0,
                doc_json=snapshot_doc_json,
                actor_id=snapshot_actor_id,
            )
            return doc

        return await self.database.execute_write_fn(write)

    async def update_doc_name(
        self, *, doc_id: int, name: str
    ) -> Optional[_queries.Doc]:
        return await self._exec(_queries.update_doc_name, doc_id=doc_id, name=name)

    async def select_doc_by_id(self, doc_id: int) -> Optional[_queries.Doc]:
        return await self._exec(_queries.select_doc_by_id, doc_id=doc_id)

    async def list_docs(self) -> list[_queries.Doc]:
        return await self._exec(_queries.list_docs)

    async def list_docs_by_ids_states_and_kinds(
        self,
        *,
        doc_ids: list[int],
        states: list[str],
        kinds: list[str],
    ) -> list[_queries.Doc]:
        # Variable-length IN goes through json_each on the SQL side; serialize
        # here so the helper signature stays three string parameters.
        doc_ids_json = json.dumps(doc_ids)
        states_json = json.dumps(states)
        kinds_json = json.dumps(kinds)

        def read(conn):
            return _queries.list_docs_by_ids_states_and_kinds(
                conn,
                doc_ids_json=doc_ids_json,
                states_json=states_json,
                kinds_json=kinds_json,
            )

        return await self.database.execute_write_fn(read)

    async def search_docs_by_title(
        self,
        *,
        doc_ids: list[int],
        q: str,
        limit: int,
    ) -> list[_queries.Doc]:
        # Variable-length IN via json_each; q is pre-wrapped into LIKE patterns
        # here so the SQL stays parameter-shaped. `like` matches anywhere,
        # `prefix` powers the prefix-hits-first ORDER BY. Empty q → both
        # collapse to "%"/"" which match everything (recent-ish fallback).
        # NOTE: LIKE metachars (% _) in q aren't escaped — acceptable for v1;
        # FTS is a later TODO.
        doc_ids_json = json.dumps(doc_ids)
        like = f"%{q}%"
        prefix = f"{q}%"

        def read(conn):
            return _queries.search_docs_by_title(
                conn,
                doc_ids_json=doc_ids_json,
                like=like,
                prefix=prefix,
                limit=limit,
            )

        return await self.database.execute_write_fn(read)

    async def list_docs_by_ids(self, *, doc_ids: list[int]) -> list[_queries.Doc]:
        # Any state, any kind — the resolve endpoint needs trashed/archived
        # rows too (a row that exists is "ok"; only a missing row is
        # "not_found"). Variable-length IN via json_each, like the siblings.
        doc_ids_json = json.dumps(doc_ids)

        def read(conn):
            return _queries.list_docs_by_ids(conn, doc_ids_json=doc_ids_json)

        return await self.database.execute_write_fn(read)

    async def list_profile_docs(
        self, *, doc_ids: list[int], actor: str, limit: int
    ) -> list[_queries.ProfileDoc]:
        """Active docs a profile actor created or edited, scoped to the
        viewer's visible ``doc_ids``, newest-activity first, capped at
        ``limit``. Backs the profile "Papers" section."""
        doc_ids_json = json.dumps(doc_ids)

        def read(conn):
            return _queries.list_profile_docs(
                conn, actor=actor, doc_ids_json=doc_ids_json, limit=limit
            )

        return await self.database.execute_write_fn(read)

    # ------------------------------------------------------------------
    # Links
    # ------------------------------------------------------------------

    async def replace_links(
        self,
        *,
        src_doc_id: int,
        src_version: int,
        edges: dict[int, int],
    ) -> None:
        # Rebuild the edge set for one src in a single transaction (mirror the
        # multi-statement insert_step pattern): delete all of src's edges, then
        # re-insert the current set. dst_doc_id is intentionally not a FK.
        def write(conn):
            _queries.delete_links_for_src(conn, src_doc_id=src_doc_id)
            for dst_doc_id, occurrences in edges.items():
                _queries.insert_link(
                    conn,
                    src_doc_id=src_doc_id,
                    dst_doc_id=dst_doc_id,
                    occurrences=occurrences,
                    src_version=src_version,
                )

        await self.database.execute_write_fn(write)

    async def links_by_src(self, *, src_doc_id: int) -> list[_queries.LinkEdge]:
        return await self._exec(_queries.select_links_by_src, src_doc_id=src_doc_id)

    async def backlinks_by_dst(
        self, *, dst_doc_id: int, viewable_ids: list[int]
    ) -> list[_queries.Backlink]:
        # Scoped to the requester's viewable set so private papers that link
        # this one aren't disclosed. JSON-encode the set for the IN clause.
        viewable_json = json.dumps(viewable_ids)

        def read(conn):
            return _queries.select_backlinks_by_dst_scoped(
                conn, dst_doc_id=dst_doc_id, viewable_json=viewable_json
            )

        return await self.database.execute_write_fn(read)

    async def edges_within(
        self, *, viewable_ids: list[int]
    ) -> list[_queries.GraphEdge]:
        # Edges whose src AND dst are both viewable. JSON-encode the set.
        viewable_json = json.dumps(viewable_ids)

        def read(conn):
            return _queries.select_edges_within(conn, viewable_json=viewable_json)

        return await self.database.execute_write_fn(read)

    # ------------------------------------------------------------------
    # Inline #tag index (derived from the materialized doc body)
    # ------------------------------------------------------------------

    async def replace_inline_tags(
        self,
        *,
        doc_id: int,
        src_version: int,
        tags: dict[str, int],
    ) -> None:
        # Rebuild the inline-tag rows for one doc in a single transaction
        # (mirror replace_links): delete all of the doc's rows, then re-insert
        # the current set. ``tags`` maps a normalized slug to its occurrence
        # count in the live doc body.
        def write(conn):
            _queries.delete_inline_tags_for_doc(conn, doc_id=doc_id)
            for tag, occurrences in tags.items():
                _queries.insert_inline_tag(
                    conn,
                    doc_id=doc_id,
                    tag=tag,
                    occurrences=occurrences,
                    src_version=src_version,
                )

        await self.database.execute_write_fn(write)

    async def tag_refs(
        self, *, tag: str, viewable_ids: list[int]
    ) -> list[_queries.TagRef]:
        # Exact, indexed lookup against the derived inline-tag index (no
        # step_json scan, no N+1 materialize loop): viewable docs that carry
        # inline ``#tag`` ``tag``, with the per-doc occurrence count.
        viewable_json = json.dumps(viewable_ids)

        def read(conn):
            return _queries.select_tag_refs_scoped(
                conn, tag=tag, viewable_json=viewable_json
            )

        return await self.database.execute_write_fn(read)

    # ------------------------------------------------------------------
    # Document tags
    # ------------------------------------------------------------------

    async def add_doc_tag(self, *, doc_id: int, tag: str) -> None:
        await self._exec(_queries.insert_doc_tag, doc_id=doc_id, tag=tag)

    async def remove_doc_tag(self, *, doc_id: int, tag: str) -> None:
        await self._exec(_queries.delete_doc_tag, doc_id=doc_id, tag=tag)

    async def set_doc_tags(self, *, doc_id: int, tags: list[str]) -> None:
        # Atomic replace: clear the doc's tags then re-insert the new set in
        # one transaction (mirror replace_links).
        def write(conn):
            _queries.delete_tags_for_doc(conn, doc_id=doc_id)
            for tag in tags:
                _queries.insert_doc_tag(conn, doc_id=doc_id, tag=tag)

        await self.database.execute_write_fn(write)

    async def list_tags_for_doc(self, *, doc_id: int) -> list[str]:
        rows = await self._exec(_queries.list_tags_for_doc, doc_id=doc_id)
        return [r.tag for r in rows]

    async def list_tags_for_docs(self, *, doc_ids: list[int]) -> dict[int, list[str]]:
        # One query for the whole list page; fold (doc_id, tag) rows into a
        # per-doc map. Docs with no tags are simply absent.
        doc_ids_json = json.dumps(doc_ids)
        rows = await self._exec(_queries.list_tags_for_docs, doc_ids_json=doc_ids_json)
        out: dict[int, list[str]] = {}
        for r in rows:
            out.setdefault(r.doc_id, []).append(r.tag)
        return out

    async def list_all_tags(self, *, doc_ids: list[int]) -> list[tuple[str, int]]:
        # Distinct tags + counts over the given (ACL-visible) doc-id scope.
        doc_ids_json = json.dumps(doc_ids)
        rows = await self._exec(_queries.list_all_tags, doc_ids_json=doc_ids_json)
        return [(r.tag, r.n) for r in rows]

    async def list_docs_by_ids_states_kinds_and_tags(
        self,
        *,
        doc_ids: list[int],
        states: list[str],
        kinds: list[str],
        tags: list[str],
    ) -> list[_queries.Doc]:
        doc_ids_json = json.dumps(doc_ids)
        states_json = json.dumps(states)
        kinds_json = json.dumps(kinds)
        # NULL (not "[]") signals "no tag filter" to the query — see
        # listDocsByIdsStatesKindsAndTags in queries.sql.
        tags_json = json.dumps(tags) if tags else None
        return await self._exec(
            _queries.list_docs_by_ids_states_kinds_and_tags,
            doc_ids_json=doc_ids_json,
            states_json=states_json,
            kinds_json=kinds_json,
            tags_json=tags_json,
        )

    # ------------------------------------------------------------------
    # State transitions (archive / trash)
    # ------------------------------------------------------------------

    async def archive_doc(self, *, doc_id: int) -> None:
        await self._exec(_queries.archive_doc, doc_id=doc_id)

    async def unarchive_doc(self, *, doc_id: int) -> None:
        await self._exec(_queries.unarchive_doc, doc_id=doc_id)

    async def trash_doc(self, *, doc_id: int, delete_at: str) -> None:
        await self._exec(_queries.trash_doc, doc_id=doc_id, delete_at=delete_at)

    async def restore_doc(self, *, doc_id: int) -> None:
        await self._exec(_queries.restore_doc, doc_id=doc_id)

    async def set_doc_kind(self, *, doc_id: int, kind: str) -> None:
        await self._exec(_queries.set_doc_kind, doc_id=doc_id, kind=kind)

    async def set_doc_locked(self, *, doc_id: int, locked: bool) -> None:
        await self._exec(
            _queries.set_doc_locked, doc_id=doc_id, locked=1 if locked else 0
        )

    async def list_trashed_to_delete(self, *, now: str) -> list[_queries.Doc]:
        return await self._exec(_queries.list_trashed_to_delete, now=now)

    async def hard_delete_doc(self, *, doc_id: int) -> None:
        """Delete the doc and all its child rows in one transaction.

        SQLite's ``ON DELETE CASCADE`` requires ``PRAGMA foreign_keys = ON``
        per-connection — we don't control every host env, so we wipe each
        child table explicitly. Order doesn't matter (no FKs honored), but
        deleting children first matches what cascade *would* do.
        """

        def write(conn):
            _queries.delete_steps_for_doc(conn, doc_id=doc_id)
            _queries.delete_snapshots_for_doc(conn, doc_id=doc_id)
            # Outgoing link edges (this doc as src) and doc-tags would
            # otherwise be orphaned — and inherited by a new doc that reuses
            # this rowid. Inbound edges (this doc as dst) are intentionally
            # kept (see m005: resolve-time decides 'not found').
            _queries.delete_links_for_src(conn, src_doc_id=doc_id)
            _queries.delete_tags_for_doc(conn, doc_id=doc_id)
            # Activity rollup carries no FK cascade (matching steps/snapshots),
            # so purge it here alongside the other child rows.
            _queries.delete_activity_for_doc(conn, doc_id=doc_id)
            _queries.hard_delete_doc(conn, doc_id=doc_id)

        await self.database.execute_write_fn(write)

    # ------------------------------------------------------------------
    # Steps
    # ------------------------------------------------------------------

    async def insert_step(
        self,
        *,
        doc_id: int,
        client_id: int,
        actor_id: Optional[str] = None,
        step_json: str,
    ) -> int:
        """Insert a step and return the new version number."""

        def write(conn):
            new_version = _queries.insert_step(
                conn,
                doc_id=doc_id,
                client_id=client_id,
                actor_id=actor_id,
                step_json=step_json,
            )
            assert new_version is not None
            _queries.bump_doc_version(conn, doc_id=doc_id, version=new_version)
            # @feat doc-activity: record this actor's edit in the activity
            # rollup. Mirrors the upsert in Instance's write_all —
            # the live collab path does NOT go through this method, so both
            # step-insert sites must keep the rollup in lock-step. Anonymous
            # steps (actor_id is None) don't attribute.
            if actor_id is not None:
                _queries.upsert_doc_activity(conn, doc_id=doc_id, actor_id=actor_id)
            return new_version

        return await self.database.execute_write_fn(write)

    async def select_steps_after(
        self, *, doc_id: int, after_version: int
    ) -> list[_queries.Step]:
        return await self._exec(
            _queries.select_steps_after, doc_id=doc_id, after_version=after_version
        )

    # ------------------------------------------------------------------
    # Snapshots
    # ------------------------------------------------------------------

    async def insert_snapshot(
        self,
        *,
        doc_id: int,
        version: int,
        doc_json: str,
        actor_id: Optional[str] = None,
    ) -> None:
        await self._exec(
            _queries.insert_snapshot,
            doc_id=doc_id,
            version=version,
            doc_json=doc_json,
            actor_id=actor_id,
        )

    async def select_latest_snapshot(
        self, *, doc_id: int
    ) -> Optional[_queries.Snapshot]:
        return await self._exec(_queries.select_latest_snapshot, doc_id=doc_id)

    async def compact_doc(self, *, doc_id: int, version: int) -> None:
        """Prune steps + snapshots superseded by the snapshot at ``version``.

        Run after a snapshot insert: every step with version <= the snapshot's
        version is folded into the snapshot doc_json, and every older snapshot
        is dead weight (hydrate reads only the latest). Both DELETEs run in one
        transaction. Safe because a client requesting evicted history gets a
        410 → full re-bootstrap from the latest snapshot.
        """

        def write(conn):
            _queries.delete_steps_up_to_version(conn, doc_id=doc_id, version=version)
            _queries.delete_snapshots_below_version(
                conn, doc_id=doc_id, version=version
            )

        await self.database.execute_write_fn(write)
