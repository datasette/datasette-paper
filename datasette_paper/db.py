"""Database operations for datasette-paper.

All operations run on Datasette's internal database. Papers are plugin
state, not user data — they live alongside Datasette's other internal
tables and are configured via ``datasette --internal <path>``.

The SQL itself lives in ``sql/queries.sql`` and is compiled into
``sql/_queries.py`` by ``just codegen-queries``. PaperDB is orchestration
only — multi-statement operations (``insert_step`` bumping the doc's
``current_version``, ``replace_shares`` rewriting visibility + share
rows) chain the generated helpers inside a single ``execute_write_fn``
closure so the transaction stays atomic.
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
    ) -> _queries.Doc:
        def write(conn):
            return _queries.insert_doc(
                conn,
                name=name,
                created_by=created_by,
                schema_name=schema_name,
            )

        doc = await self.database.execute_write_fn(write)
        assert doc is not None
        return doc

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

    async def list_docs_by_ids(self, *, doc_ids: list[int]) -> list[_queries.Doc]:
        # Variable-length IN goes through json_each on the SQL side; serialize
        # here so the helper signature stays a single string parameter.
        doc_ids_json = json.dumps(doc_ids)

        def read(conn):
            return _queries.list_docs_by_ids(conn, doc_ids_json=doc_ids_json)

        return await self.database.execute_write_fn(read)

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

    # ------------------------------------------------------------------
    # Shares
    # ------------------------------------------------------------------

    async def select_shares(self, *, doc_id: int) -> list[_queries.Share]:
        def read(conn):
            return _queries.select_shares(conn, doc_id=doc_id)

        return await self.database.execute_write_fn(read)

    async def replace_shares(
        self,
        *,
        doc_id: int,
        visibility: str,
        shares: list[tuple[str, str]],
        granted_by: Optional[str],
    ) -> None:
        """Replace the share state for *doc_id* atomically.

        *shares* is a list of ``(actor_id, role)`` tuples. Caller has
        already validated each role is in ``('viewer','editor')``.
        Visibility is validated against the doc table's CHECK constraint.
        """

        def write(conn):
            _queries.update_doc_visibility(conn, doc_id=doc_id, visibility=visibility)
            _queries.delete_shares_for_doc(conn, doc_id=doc_id)
            for actor_id, role in shares:
                _queries.insert_share(
                    conn,
                    doc_id=doc_id,
                    actor_id=actor_id,
                    role=role,
                    granted_by=granted_by,
                )

        await self.database.execute_write_fn(write)
