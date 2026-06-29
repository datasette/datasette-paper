"""T03 — publish/view routes, paper-published-view ACL, caching, 404 semantics.

Uses the HTTP API end-to-end (all-live publishing; frozen execution is T05).
"""

from __future__ import annotations

import pytest

from tests.conftest import setup_paper_datasette


def _cookie(ds, actor_id: str) -> dict:
    return {"ds_actor": ds.sign({"a": {"id": actor_id}}, "actor")}


async def _make_doc(ds, name="Pub Doc") -> int:
    resp = await ds.client.post("/-/paper/api/docs", json={"name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _publish(ds, doc_id, **body):
    return await ds.client.post(f"/-/paper/api/docs/{doc_id}/publish", json=body)


@pytest.mark.asyncio
async def test_publish_then_owner_can_view():
    ds, _ = await setup_paper_datasette()
    doc_id = await _make_doc(ds)

    resp = await _publish(ds, doc_id)
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["ok"] is True
    assert payload["version"] == 0
    assert payload["url"] == f"/-/paper/doc/{doc_id}/publish"

    page = await ds.client.get(f"/-/paper/doc/{doc_id}/publish")
    assert page.status_code == 200
    assert 'class="paper-published"' in page.text
    assert page.headers["etag"] == f'"{doc_id}-0"'


@pytest.mark.asyncio
async def test_non_manager_cannot_publish():
    ds, _ = await setup_paper_datasette()
    doc_id = await _make_doc(ds)
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/publish", json={}, cookies=_cookie(ds, "bob")
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_out_of_audience_and_unpublished_are_404():
    ds, _ = await setup_paper_datasette()
    doc_id = await _make_doc(ds)

    # Never published → 404 (no existence leak), even for the owner.
    pre = await ds.client.get(f"/-/paper/doc/{doc_id}/publish")
    assert pre.status_code == 404

    await _publish(ds, doc_id)

    # A stranger not in the audience → 404, not 403.
    stranger = await ds.client.get(
        f"/-/paper/doc/{doc_id}/publish", cookies=_cookie(ds, "bob")
    )
    assert stranger.status_code == 404


@pytest.mark.asyncio
async def test_public_audience_allows_anonymous_and_is_cacheable():
    ds, _ = await setup_paper_datasette()
    doc_id = await _make_doc(ds)
    resp = await _publish(ds, doc_id, audience=[{"principal": "everyone"}])
    assert resp.status_code == 200

    # Anonymous (garbage cookie → no actor) can read the public page.
    anon = await ds.client.get(
        f"/-/paper/doc/{doc_id}/publish", cookies={"ds_actor": "nonsense"}
    )
    assert anon.status_code == 200
    assert anon.headers["cache-control"].startswith("public")
    assert "vary" not in {k.lower() for k in anon.headers}


@pytest.mark.asyncio
async def test_private_audience_is_not_shared_cacheable():
    ds, _ = await setup_paper_datasette()
    doc_id = await _make_doc(ds)
    await _publish(ds, doc_id)  # owner-only audience
    page = await ds.client.get(f"/-/paper/doc/{doc_id}/publish")
    assert page.status_code == 200
    assert page.headers["cache-control"] == "private, no-cache"
    assert page.headers["vary"] == "Cookie"


@pytest.mark.asyncio
async def test_conditional_get_304():
    ds, _ = await setup_paper_datasette()
    doc_id = await _make_doc(ds)
    await _publish(ds, doc_id)
    etag = (await ds.client.get(f"/-/paper/doc/{doc_id}/publish")).headers["etag"]

    not_modified = await ds.client.get(
        f"/-/paper/doc/{doc_id}/publish", headers={"if-none-match": etag}
    )
    assert not_modified.status_code == 304

    stale = await ds.client.get(
        f"/-/paper/doc/{doc_id}/publish", headers={"if-none-match": '"0-0"'}
    )
    assert stale.status_code == 200


@pytest.mark.asyncio
async def test_unpublish_404s_then_republish_restores():
    ds, paper = await setup_paper_datasette()
    doc_id = await _make_doc(ds)
    await _publish(ds, doc_id)
    assert (await ds.client.get(f"/-/paper/doc/{doc_id}/publish")).status_code == 200

    un = await ds.client.post(f"/-/paper/api/docs/{doc_id}/unpublish", json={})
    assert un.status_code == 200
    assert (await ds.client.get(f"/-/paper/doc/{doc_id}/publish")).status_code == 404
    # Row retained.
    assert await paper.select_publication(doc_id=doc_id, version=0) is not None

    await _publish(ds, doc_id)
    assert (await ds.client.get(f"/-/paper/doc/{doc_id}/publish")).status_code == 200


@pytest.mark.asyncio
async def test_republish_new_version_moves_pointer_and_etag():
    ds, paper = await setup_paper_datasette()
    doc_id = await _make_doc(ds)
    await _publish(ds, doc_id, version=0)
    assert (await ds.client.get(f"/-/paper/doc/{doc_id}/publish")).headers[
        "etag"
    ] == f'"{doc_id}-0"'

    # Plant a snapshot at v5 so version 5 materializes, then publish it.
    await paper.insert_snapshot(
        doc_id=doc_id,
        version=5,
        doc_json='{"type":"doc","content":[{"type":"paragraph"}]}',
        actor_id="alice",
    )
    await _publish(ds, doc_id, version=5)
    page = await ds.client.get(f"/-/paper/doc/{doc_id}/publish")
    assert page.headers["etag"] == f'"{doc_id}-5"'
    # Permalink to the old version still resolves.
    old = await ds.client.get(f"/-/paper/doc/{doc_id}/publish/v/0")
    assert old.status_code == 200
    assert old.headers["etag"] == f'"{doc_id}-0"'


@pytest.mark.asyncio
async def test_publications_list_and_preview():
    ds, _ = await setup_paper_datasette()
    doc_id = await _make_doc(ds)
    await _publish(ds, doc_id)

    lst = await ds.client.get(f"/-/paper/api/docs/{doc_id}/publications")
    assert lst.status_code == 200
    body = lst.json()
    assert body["published_version"] == 0
    assert body["publications"][0]["version"] == 0
    assert body["publications"][0]["is_current"] is True

    prev = await ds.client.get(f"/-/paper/api/docs/{doc_id}/publish/preview")
    assert prev.status_code == 200
    assert "html" in prev.json()


@pytest.mark.asyncio
async def test_trashed_doc_publish_page_404s():
    ds, _ = await setup_paper_datasette()
    doc_id = await _make_doc(ds)
    await _publish(ds, doc_id, audience=[{"principal": "everyone"}])
    assert (await ds.client.get(f"/-/paper/doc/{doc_id}/publish")).status_code == 200
    # Trash the live doc → published page should 404.
    await ds.client.post(f"/-/paper/api/docs/{doc_id}/trash", json={})
    assert (await ds.client.get(f"/-/paper/doc/{doc_id}/publish")).status_code == 404
