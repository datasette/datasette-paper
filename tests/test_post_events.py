"""Tests for POST /-/paper/api/docs/:id/events."""

from __future__ import annotations

import asyncio
import json

import pytest

from datasette_paper.instance import get_registry

from _steps import insert_at  # noqa: E402  (sibling helper)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_doc(datasette, name="Test Paper"):
    resp = await datasette.client.post(
        "/-/paper/api/docs",
        json={"name": name},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


# A minimal valid `replace` step against the empty starter doc
# (`paragraph()`): inserts "." at position 1 (inside the paragraph).
STEP_BODY_JSON = insert_at(1)
STEP_BODY = json.loads(STEP_BODY_JSON)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_at_version_0_succeeds(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    body = {
        "version": 0,
        "clientID": 42,
        "steps": [STEP_BODY_JSON],
    }
    resp = await ds.client.post(url, json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"] == 1

    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert len(steps) == 1
    assert steps[0].client_id == 42


@pytest.mark.asyncio
# @feat collab-sse: test: stale-version POST returns 409
async def test_post_stale_version_409(ds):
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    body = {
        "version": 0,
        "clientID": 1,
        "steps": [STEP_BODY_JSON],
    }

    resp1 = await ds.client.post(url, json=body)
    assert resp1.status_code == 200

    resp2 = await ds.client.post(url, json=body)
    assert resp2.status_code == 409


@pytest.mark.asyncio
async def test_post_invalid_version_400(ds):
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    body = {
        "version": 99,
        "clientID": 1,
        "steps": [STEP_BODY_JSON],
    }
    resp = await ds.client.post(url, json=body)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_post_unknown_doc_403(ds):
    """Per-doc edit permission denies unknown docs at the gate."""
    url = "/-/paper/api/docs/99999/events"
    body = {
        "version": 0,
        "clientID": 1,
        "steps": [STEP_BODY_JSON],
    }
    resp = await ds.client.post(url, json=body)
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_post_persists_actor_id(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    body = {
        "version": 0,
        "clientID": 7,
        "steps": [STEP_BODY_JSON],
    }

    actor_cookie = ds.client.actor_cookie({"id": "alice"})
    resp = await ds.client.post(url, json=body, cookies={"ds_actor": actor_cookie})
    assert resp.status_code == 200

    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert len(steps) == 1
    assert steps[0].actor_id == "alice"


# ---------------------------------------------------------------------------
# Step validation (422 path) — added with the write-time validation gate
# in `Instance.add_events`.
#
# The minimal repro: doc starts as the empty `paragraph()`. POST a `replace`
# step whose `from`/`to` resolve at the doc level (position 0) with a bare
# text slice — `<text("x"), paragraph()>` violates doc's `block+` content
# spec. Before validation landed this would 200 and corrupt history; now
# it must 422 with the step index and no rows written.
# ---------------------------------------------------------------------------


BAD_STEP_AT_DOC_LEVEL = json.dumps(
    {
        "stepType": "replace",
        "from": 0,
        "to": 0,
        "slice": {"content": [{"type": "text", "text": "x"}]},
    }
)


@pytest.mark.asyncio
async def test_post_invalid_step_422_with_step_index(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    resp = await ds.client.post(
        url,
        json={
            "version": 0,
            "clientID": 1,
            "steps": [BAD_STEP_AT_DOC_LEVEL],
        },
    )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["error"] == "invalid_step"
    assert body["step_index"] == 0
    assert "Invalid content" in body["message"] or "doc" in body["message"]

    # Critical: the bad batch must NOT have written anything. If we let a
    # 422 leave a row behind, we're back to corruption-by-write that the
    # gate was supposed to stop.
    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert steps == []

    # And the doc's current_version stayed at 0.
    doc = await paper_db.select_doc_by_id(doc_id)
    assert doc.current_version == 0


@pytest.mark.asyncio
async def test_post_oversized_step_rejected_422(ds_paper):
    """A single step over MAX_STEP_BYTES is rejected before any write.

    The markdown-parser / browser-paste guards never see a step POSTed
    straight to the events route, so the size cap in `_validate_steps` is
    the backstop against a multi-MB image node (or other bloat) injected
    directly. Build an oversized-but-otherwise-valid `replace` step.
    """
    from datasette_paper.instance import MAX_STEP_BYTES

    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    huge = insert_at(1, "x" * (MAX_STEP_BYTES + 1024))
    assert len(huge) > MAX_STEP_BYTES

    url = f"/-/paper/api/docs/{doc_id}/events"
    resp = await ds.client.post(
        url,
        json={"version": 0, "clientID": 1, "steps": [huge]},
    )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["error"] == "invalid_step"
    assert body["step_index"] == 0
    assert "too large" in body["message"]

    # Nothing written; version unchanged.
    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert steps == []
    doc = await paper_db.select_doc_by_id(doc_id)
    assert doc.current_version == 0


@pytest.mark.asyncio
async def test_post_invalid_step_is_atomic_across_batch(ds_paper):
    """A batch with some valid steps before a bad one rolls back the whole batch."""
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    resp = await ds.client.post(
        url,
        json={
            "version": 0,
            "clientID": 1,
            "steps": [
                insert_at(1, "a"),
                insert_at(2, "b"),
                insert_at(3, "c"),
                BAD_STEP_AT_DOC_LEVEL,
                insert_at(4, "d"),
            ],
        },
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["step_index"] == 3

    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert steps == []


@pytest.mark.asyncio
async def test_post_unparseable_step_422(ds_paper):
    """A step JSON that prosemirror-py can't even parse is rejected the same way."""
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    resp = await ds.client.post(
        url,
        json={
            "version": 0,
            "clientID": 1,
            # Missing required keys (from/to/slice) — Step.from_json raises.
            "steps": [json.dumps({"stepType": "replace"})],
        },
    )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["step_index"] == 0
    assert "parse failed" in body["message"]

    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert steps == []


@pytest.mark.asyncio
async def test_post_with_poisoned_history_returns_clear_422(ds_paper):
    """A poisoned step already in history (planted before validation
    landed, or surviving a schema divergence) leaves the server's
    materialized doc stuck at the last good version while the version
    counter advances. Old behavior: subsequent POSTs failed with the
    underlying position / content error, which mis-blames the user's
    new step. New behavior: a single 422 marker, `history corrupted at
    version N: ...`, surfaces the actual cause."""
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    # Plant a bad step at v=1 directly via db.insert_step (no
    # validation) — same shape as BAD_STEP_AT_DOC_LEVEL.
    await paper_db.insert_step(
        doc_id=doc_id,
        client_id=1,
        actor_id=None,
        step_json=BAD_STEP_AT_DOC_LEVEL,
    )

    # Force a re-hydrate so the in-memory Instance picks up the
    # planted step rather than continuing from the cached empty state.
    get_registry(ds)._instances.pop(doc_id, None)

    # The client thinks it's at v=1 and tries a valid edit. With the
    # gate in place, the server rejects with a clear marker.
    url = f"/-/paper/api/docs/{doc_id}/events"
    resp = await ds.client.post(
        url,
        json={
            "version": 1,
            "clientID": 2,
            "steps": [insert_at(1, "y")],
        },
    )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["error"] == "invalid_step"
    assert body["step_index"] == 0
    assert "history corrupted" in body["message"]
    assert "version 1" in body["message"]

    # And no new step was written — the bad v=1 row is still alone.
    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert len(steps) == 1


@pytest.mark.asyncio
async def test_post_invalid_step_does_not_broadcast(ds_paper):
    """A rejected batch must not show up on any subscriber's queue."""
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    registry = get_registry(ds)
    instance = await registry.get(paper_db, doc_id)
    q = await instance.subscribe()

    url = f"/-/paper/api/docs/{doc_id}/events"
    resp = await ds.client.post(
        url,
        json={
            "version": 0,
            "clientID": 1,
            "steps": [BAD_STEP_AT_DOC_LEVEL],
        },
    )
    assert resp.status_code == 422

    # The broadcast queue should stay empty — the write txn never ran.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(q.get(), timeout=0.1)


@pytest.mark.asyncio
async def test_post_validates_against_post_update_doc(ds_paper):
    """Validation runs against the materialized doc *after* prior steps applied,
    not the snapshot.

    Send a valid step, then a second one whose `from` only makes sense if
    the first applied. If the validator used the snapshot doc, the second
    step would fail; against the live (post-first-step) doc it succeeds.
    """
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)
    url = f"/-/paper/api/docs/{doc_id}/events"

    # Step 1: insert "X" at pos 1 of paragraph() → paragraph("X").
    r1 = await ds.client.post(
        url,
        json={"version": 0, "clientID": 1, "steps": [insert_at(1, "X")]},
    )
    assert r1.status_code == 200
    assert r1.json()["version"] == 1

    # Step 2: insert "Y" at pos 2 — only valid if "X" is already there.
    # Against the snapshot doc (paragraph(), size 2), pos 2 is the doc-
    # level position after the paragraph; inserting text there violates
    # doc's `block+` spec. Against the live doc (paragraph("X"), size 3),
    # pos 2 lands inside the paragraph at offset 1 — valid.
    r2 = await ds.client.post(
        url,
        json={"version": 1, "clientID": 1, "steps": [insert_at(2, "Y")]},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["version"] == 2

    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert len(steps) == 2


# ---------------------------------------------------------------------------
# Stored-XSS guard (blockers-0629/01): a crafted step planting a
# `javascript:` link href (or image src) must be rejected server-side and
# never persisted, even though it bypasses the UI and the markdown parser.
# ---------------------------------------------------------------------------


# `replace` step inserting a text node carrying a `javascript:` link mark
# into the empty starter paragraph (pos 1) — the exact crafted-step vector.
XSS_LINK_STEP = json.dumps(
    {
        "stepType": "replace",
        "from": 1,
        "to": 1,
        "slice": {
            "content": [
                {
                    "type": "text",
                    "text": "click me",
                    "marks": [
                        {"type": "link", "attrs": {"href": "javascript:alert(1)"}}
                    ],
                }
            ]
        },
    }
)


@pytest.mark.asyncio
async def test_post_crafted_javascript_link_rejected_422(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    resp = await ds.client.post(
        url,
        json={"version": 0, "clientID": 1, "steps": [XSS_LINK_STEP]},
    )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["error"] == "invalid_step"
    assert body["step_index"] == 0
    assert "blocked link href" in body["message"]

    # Nothing written; version unchanged.
    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert steps == []
    doc = await paper_db.select_doc_by_id(doc_id)
    assert doc.current_version == 0


@pytest.mark.asyncio
async def test_post_crafted_javascript_image_src_rejected_422(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    bad_image = json.dumps(
        {
            "stepType": "replace",
            "from": 1,
            "to": 1,
            "slice": {
                "content": [{"type": "image", "attrs": {"src": "javascript:alert(1)"}}],
                # An inline image inserted into the paragraph needs the slice
                # openStart/openEnd defaults (0) — it's a leaf inline atom.
            },
        }
    )
    resp = await ds.client.post(
        url,
        json={"version": 0, "clientID": 1, "steps": [bad_image]},
    )
    assert resp.status_code == 422, resp.text
    assert "blocked image src" in resp.json()["message"]

    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert steps == []


@pytest.mark.asyncio
async def test_post_safe_link_href_persists(ds_paper):
    """A normal https link mark is accepted — the guard only blocks bad schemes."""
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    good = json.dumps(
        {
            "stepType": "replace",
            "from": 1,
            "to": 1,
            "slice": {
                "content": [
                    {
                        "type": "text",
                        "text": "click me",
                        "marks": [
                            {"type": "link", "attrs": {"href": "https://example.com"}}
                        ],
                    }
                ]
            },
        }
    )
    url = f"/-/paper/api/docs/{doc_id}/events"
    resp = await ds.client.post(
        url,
        json={"version": 0, "clientID": 1, "steps": [good]},
    )
    assert resp.status_code == 200, resp.text
    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert len(steps) == 1


@pytest.mark.asyncio
async def test_post_broadcasts_to_subscribers(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    registry = get_registry(ds)
    instance = await registry.get(paper_db, doc_id)

    q = await instance.subscribe()

    url = f"/-/paper/api/docs/{doc_id}/events"
    body = {
        "version": 0,
        "clientID": 5,
        "steps": [STEP_BODY_JSON],
    }
    resp = await ds.client.post(url, json=body)
    assert resp.status_code == 200

    payload = await asyncio.wait_for(q.get(), timeout=1.0)
    assert payload["version"] == 1
    assert len(payload["steps"]) == 1
    assert payload["clientIDs"][0] == 5


# ---------------------------------------------------------------------------
# Schema lock-step: new node types apply server-side (pm_schema.py mirrors
# frontend/src/lib/schema.ts). A divergence here yields a 422 InvalidStepError.
# ---------------------------------------------------------------------------


def _insert_node(pos: int, node: dict) -> str:
    """JSON-encoded `replace` step inserting a single node at `pos`."""
    return json.dumps(
        {
            "stepType": "replace",
            "from": pos,
            "to": pos,
            "slice": {"content": [node]},
        }
    )


@pytest.mark.asyncio
async def test_post_inline_and_block_embed_apply(ds_paper):
    """A step inserting an `inline_embed` (inline) and one inserting a
    `block_embed` (block) both validate + apply — proving pm_schema.py
    mirrors the JS schema (no 422), and the materializer round-trips them to
    markdown."""
    ds, _paper_db = ds_paper
    doc_id = await _create_doc(ds)
    url = f"/-/paper/api/docs/{doc_id}/events"

    # Inline ref inside the empty starter paragraph (pos 1).
    ref_node = {"type": "inline_embed", "attrs": {"ref": "/fixtures/facetable"}}
    r1 = await ds.client.post(
        url,
        json={"version": 0, "clientID": 1, "steps": [_insert_node(1, ref_node)]},
    )
    assert r1.status_code == 200, r1.text
    assert r1.json()["version"] == 1

    # Block embed appended after the paragraph (doc end is now at pos 3:
    # paragraph open + inline atom + close).
    embed_node = {
        "type": "block_embed",
        "attrs": {"ref": "/fixtures/facetable", "mode": "table"},
    }
    r2 = await ds.client.post(
        url,
        json={"version": 1, "clientID": 1, "steps": [_insert_node(3, embed_node)]},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["version"] == 2

    # The materialized doc round-trips both nodes to markdown.
    doc = await ds.client.get(f"/-/paper/api/docs/{doc_id}/document")
    assert doc.status_code == 200
    md = doc.json()["content_markdown"]
    assert "[/fixtures/facetable](paper:/embed/datasette/fixtures/facetable)" in md
    assert (
        '```paper-embed\n{"config":{},"mode":"table","ref":"/fixtures/facetable"}\n```'
        in md
    )
