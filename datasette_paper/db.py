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
share read/write helpers here — the ``<datasette-share-dialog>`` component
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
        def write(conn):
            return _queries.update_doc_name(conn, doc_id=doc_id, name=name)

        return await self.database.execute_write_fn(write)

    async def select_doc_by_id(self, doc_id: int) -> Optional[_queries.Doc]:
        def read(conn):
            return _queries.select_doc_by_id(conn, doc_id=doc_id)

        return await self.database.execute_write_fn(read)

    async def list_docs(self) -> list[_queries.Doc]:
        return await self.database.execute_write_fn(_queries.list_docs)

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

    # ------------------------------------------------------------------
    # State transitions (archive / trash)
    # ------------------------------------------------------------------

    async def archive_doc(self, *, doc_id: int) -> None:
        def write(conn):
            _queries.archive_doc(conn, doc_id=doc_id)

        await self.database.execute_write_fn(write)

    async def unarchive_doc(self, *, doc_id: int) -> None:
        def write(conn):
            _queries.unarchive_doc(conn, doc_id=doc_id)

        await self.database.execute_write_fn(write)

    async def trash_doc(self, *, doc_id: int, delete_at: str) -> None:
        def write(conn):
            _queries.trash_doc(conn, doc_id=doc_id, delete_at=delete_at)

        await self.database.execute_write_fn(write)

    async def restore_doc(self, *, doc_id: int) -> None:
        def write(conn):
            _queries.restore_doc(conn, doc_id=doc_id)

        await self.database.execute_write_fn(write)

    async def set_doc_kind(self, *, doc_id: int, kind: str) -> None:
        def write(conn):
            _queries.set_doc_kind(conn, doc_id=doc_id, kind=kind)

        await self.database.execute_write_fn(write)

    async def set_doc_locked(self, *, doc_id: int, locked: bool) -> None:
        def write(conn):
            _queries.set_doc_locked(conn, doc_id=doc_id, locked=1 if locked else 0)

        await self.database.execute_write_fn(write)

    async def list_trashed_to_delete(self, *, now: str) -> list[_queries.Doc]:
        def read(conn):
            return _queries.list_trashed_to_delete(conn, now=now)

        return await self.database.execute_write_fn(read)

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
            return new_version

        return await self.database.execute_write_fn(write)

    async def select_steps_after(
        self, *, doc_id: int, after_version: int
    ) -> list[_queries.Step]:
        def read(conn):
            return _queries.select_steps_after(
                conn, doc_id=doc_id, after_version=after_version
            )

        return await self.database.execute_write_fn(read)

    async def select_max_version(self, *, doc_id: int) -> Optional[int]:
        def read(conn):
            return _queries.select_max_version(conn, doc_id=doc_id)

        return await self.database.execute_write_fn(read)

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
        def write(conn):
            _queries.insert_snapshot(
                conn,
                doc_id=doc_id,
                version=version,
                doc_json=doc_json,
                actor_id=actor_id,
            )

        await self.database.execute_write_fn(write)

    async def select_latest_snapshot(
        self, *, doc_id: int
    ) -> Optional[_queries.Snapshot]:
        def read(conn):
            return _queries.select_latest_snapshot(conn, doc_id=doc_id)

        return await self.database.execute_write_fn(read)
