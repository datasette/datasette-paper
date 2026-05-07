"""Microbenchmarks for the datasette-paper storage hot paths.

What we care about, in priority order:
  1. Edit latency  — `Instance.add_events` for a one-character typing step.
  2. Bootstrap     — `Instance.hydrate` (cold) + the steps_after replay cost.
  3. Snapshot      — `record_client_doc` write of the current doc.
  4. Storage       — bytes/row in `_datasette_paper_step` and `_datasette_paper_snapshot`.

We exercise the real code paths (Instance / PaperDB / Datasette write queue) so
results reflect what production sees, not what a hand-rolled SQLite loop sees.

Run: `uv run --prerelease=allow python bench/bench_paper.py [--scenario NAME]`
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import tempfile
import time
from dataclasses import dataclass
from typing import Callable, Awaitable

from datasette.app import Datasette

from datasette_paper.db import PaperDB
from datasette_paper.instance import Instance, SNAPSHOT_THRESHOLD


# ── Test fixtures ───────────────────────────────────────────────────────────


async def fresh_db() -> tuple[PaperDB, Datasette, str, str]:
    """Spin up a tempfile-backed Datasette and migrate it. Returns
    (PaperDB, Datasette, db_name, file_path) so the caller can clean up."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    ds = Datasette([tmp.name])
    db_name = os.path.basename(tmp.name).replace(".db", "")
    db = PaperDB(ds.get_database(db_name))
    await db.ensure_migrations()
    return db, ds, db_name, tmp.name


def typing_step(at: int, char: str = "x") -> dict:
    """A ProseMirror `replace` step that inserts one text character at *at*.

    The steps_tail stores these as TEXT JSON; the wire format ships them as
    parsed objects. This shape matches what the real client produces while
    typing a paragraph."""
    return {
        "stepType": "replace",
        "from": at,
        "to": at,
        "slice": {"content": [{"type": "text", "text": char}]},
    }


def big_doc(paragraphs: int, words_per_paragraph: int = 50) -> dict:
    """A synthetic ProseMirror doc of approximately the requested size."""
    para_text = " ".join(["lorem"] * words_per_paragraph)
    return {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": para_text}],
            }
            for _ in range(paragraphs)
        ],
    }


# ── Timing helpers ─────────────────────────────────────────────────────────


@dataclass
class Sample:
    label: str
    n: int
    times_ms: list[float]

    @property
    def p50(self) -> float:
        return statistics.median(self.times_ms)

    @property
    def p95(self) -> float:
        s = sorted(self.times_ms)
        return s[min(len(s) - 1, int(len(s) * 0.95))]

    @property
    def mean(self) -> float:
        return statistics.fmean(self.times_ms)

    def line(self) -> str:
        return (
            f"{self.label:<48s}  n={self.n:>5d}  "
            f"mean={self.mean:7.2f}ms  p50={self.p50:7.2f}ms  p95={self.p95:7.2f}ms"
        )


async def time_one(coro_fn: Callable[[], Awaitable[None]]) -> float:
    t0 = time.perf_counter()
    await coro_fn()
    return (time.perf_counter() - t0) * 1000.0


# ── Scenarios ──────────────────────────────────────────────────────────────


async def bench_edit_latency(steps: int = 2000) -> Sample:
    """Time a single-character POST-events round through Instance.add_events.

    Measures: write-queue serialization + insert_step + select_steps_after
    (used to fetch the row's created_at) + tail append + broadcast."""
    db, ds, _, path = await fresh_db()
    try:
        doc = await db.insert_doc(name="bench")
        inst = await Instance.hydrate(db, doc.id)
        times = []
        for i in range(steps):
            step = typing_step(at=1 + i)
            t = await time_one(
                lambda: inst.add_events(
                    version=inst.version,
                    client_id=42,
                    actor_id=None,
                    steps=[step],
                    comment_events=[],
                )
            )
            times.append(t)
        return Sample(f"add_events 1 step  (warm, after {steps} writes)", steps, times)
    finally:
        os.unlink(path)


async def bench_hydrate_cold(steps_count: int) -> Sample:
    """Time Instance.hydrate when the latest snapshot is far behind HEAD.

    We seed `steps_count` step rows on top of the empty snapshot so hydrate
    has to pull them all and JSON-decode each into the steps_tail."""
    db, ds, _, path = await fresh_db()
    try:
        doc = await db.insert_doc(name="bench")
        inst = await Instance.hydrate(db, doc.id)
        for i in range(steps_count):
            await inst.add_events(
                version=inst.version,
                client_id=1,
                actor_id=None,
                steps=[typing_step(at=1 + i)],
                comment_events=[],
            )
        # Now drop the in-memory state and time a fresh hydrate.
        times = []
        for _ in range(5):
            t = await time_one(lambda: Instance.hydrate(db, doc.id))
            times.append(t)
        return Sample(f"hydrate cold @ {steps_count} steps since snapshot", 5, times)
    finally:
        os.unlink(path)


async def bench_bootstrap_payload(steps_count: int) -> Sample:
    """Time the work the GET /api/docs/:id bootstrap handler does after
    hydrate: filter steps_tail, JSON-parse each step_json, build payload."""
    db, ds, _, path = await fresh_db()
    try:
        doc = await db.insert_doc(name="bench")
        inst = await Instance.hydrate(db, doc.id)
        for i in range(steps_count):
            await inst.add_events(
                version=inst.version,
                client_id=1,
                actor_id=None,
                steps=[typing_step(at=1 + i)],
                comment_events=[],
            )
        # Now simulate the route work (snapshot replay).
        times = []
        for _ in range(20):

            def build():
                steps_after = [
                    s for s in inst.steps_tail if s["version"] > inst.snapshot_version
                ]
                payload = {
                    "doc": json.loads(inst.snapshot_doc_json),
                    "snapshotVersion": inst.snapshot_version,
                    "version": inst.version,
                    "steps": [json.loads(s["step_json"]) for s in steps_after],
                    "clientIDs": [s["client_id"] for s in steps_after],
                }
                return payload

            t0 = time.perf_counter()
            build()
            times.append((time.perf_counter() - t0) * 1000.0)
        return Sample(f"bootstrap payload build  ({steps_count} steps tail)", 20, times)
    finally:
        os.unlink(path)


async def bench_snapshot(doc_paragraphs: int) -> Sample:
    """Time a snapshot insert for a doc of a given size.

    We advance the doc version between iterations (and reset
    snapshot_version) so each iteration writes a fresh snapshot row at a
    distinct (doc_id, version) — the table's primary key would reject a
    repeat write at the same version."""
    db, ds, _, path = await fresh_db()
    try:
        doc = await db.insert_doc(name="bench")
        inst = await Instance.hydrate(db, doc.id)
        body = json.dumps(big_doc(paragraphs=doc_paragraphs))
        times = []
        for k in range(10):
            # Append SNAPSHOT_THRESHOLD steps so version advances enough for
            # the next record_client_doc to actually fire.
            for i in range(SNAPSHOT_THRESHOLD):
                await inst.add_events(
                    version=inst.version,
                    client_id=1,
                    actor_id=None,
                    steps=[typing_step(at=1 + i)],
                    comment_events=[],
                )
            t = await time_one(
                lambda: inst.record_client_doc(inst.version, body, actor_id=None)
            )
            times.append(t)
        size_kb = len(body) / 1024
        return Sample(
            f"record_client_doc  ({doc_paragraphs} paragraphs ≈ {size_kb:.1f}KB)",
            len(times),
            times,
        )
    finally:
        os.unlink(path)


async def bench_storage(steps_count: int = 1000) -> dict:
    """Measure on-disk bytes spent on step rows vs. payload bytes."""
    db, ds, _, path = await fresh_db()
    try:
        doc = await db.insert_doc(name="bench")
        inst = await Instance.hydrate(db, doc.id)
        for i in range(steps_count):
            await inst.add_events(
                version=inst.version,
                client_id=1,
                actor_id=None,
                steps=[typing_step(at=1 + i)],
                comment_events=[],
            )
        # Sum step_json byte length (the payload PM cares about) vs. row count
        # vs. file size, to get a rough overhead estimate.
        total_payload = await ds.get_database(
            os.path.basename(path).replace(".db", "")
        ).execute(
            "SELECT SUM(LENGTH(step_json)), COUNT(*) FROM _datasette_paper_step "
            "WHERE doc_id = ?",
            [doc.id],
        )
        payload_bytes, n = total_payload.first()
        file_bytes = os.path.getsize(path)
        return {
            "steps": n,
            "step_json_bytes_total": payload_bytes,
            "step_json_bytes_avg": payload_bytes / n if n else 0,
            "file_bytes": file_bytes,
            "file_bytes_per_step": file_bytes / n if n else 0,
        }
    finally:
        os.unlink(path)


# ── Driver ─────────────────────────────────────────────────────────────────


SCENARIOS: dict[str, Callable[[], Awaitable[object]]] = {
    "edit": lambda: bench_edit_latency(steps=2000),
    "hydrate-100": lambda: bench_hydrate_cold(100),
    "hydrate-1000": lambda: bench_hydrate_cold(1000),
    "hydrate-5000": lambda: bench_hydrate_cold(5000),
    "bootstrap-100": lambda: bench_bootstrap_payload(100),
    "bootstrap-1000": lambda: bench_bootstrap_payload(1000),
    "snapshot-small": lambda: bench_snapshot(doc_paragraphs=10),
    "snapshot-medium": lambda: bench_snapshot(doc_paragraphs=200),
    "snapshot-large": lambda: bench_snapshot(doc_paragraphs=2000),
    "storage": lambda: bench_storage(steps_count=1000),
}


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", "-s", choices=list(SCENARIOS), action="append")
    args = parser.parse_args()
    selected = args.scenario or list(SCENARIOS)
    print(f"running {len(selected)} scenario(s)\n")
    for name in selected:
        result = await SCENARIOS[name]()
        if isinstance(result, Sample):
            print(result.line())
        else:
            print(f"{name:<48s}  {result}")
    print()


if __name__ == "__main__":
    asyncio.run(main())
