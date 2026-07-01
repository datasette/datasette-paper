"""Tests for creating a doc seeded from markdown (POST /-/paper/api/docs).

``content`` is a third seed source alongside blank and ``template_id`` — the
markdown is parsed to the version-0 snapshot via ``markdown_to_doc``.
Blank + template creation are covered in test_routes_docs / test_templates.
"""

import pytest


async def _document_markdown(ds, doc_id):
    resp = await ds.client.get(f"/-/paper/api/docs/{doc_id}/document")
    assert resp.status_code == 200
    return resp.json()["content_markdown"]


@pytest.mark.asyncio
async def test_create_from_markdown(ds):
    resp = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Seeded", "content": "# Hello\n\nA **bold** start.\n"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Seeded"
    assert body["kind"] == "doc"

    md = await _document_markdown(ds, body["id"])
    assert "# Hello" in md
    assert "A **bold** start." in md


@pytest.mark.asyncio
async def test_create_from_markdown_rich_content(ds):
    content = (
        "## Plan\n\n"
        "1. first\n2. second\n\n"
        "- [ ] open task\n- [x] done task\n\n"
        "| col | val |\n| --- | --- |\n| a | 1 |\n"
    )
    resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Rich", "content": content}
    )
    assert resp.status_code == 201
    md = await _document_markdown(ds, resp.json()["id"])
    assert "## Plan" in md
    assert "- [x] done task" in md
    assert "| col | val |" in md


@pytest.mark.asyncio
async def test_create_template_from_markdown(ds):
    """content seeds either kind — here a template."""
    resp = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Tmpl", "kind": "template", "content": "# Standup\n"},
    )
    assert resp.status_code == 201
    assert resp.json()["kind"] == "template"

    # The new template shows up in the templates listing.
    listing = await ds.client.get("/-/paper/api/docs?kind=template")
    assert "Tmpl" in {d["name"] for d in listing.json()}


@pytest.mark.asyncio
async def test_create_rejects_content_and_template_id_together(ds):
    # Seed a template to reference.
    tmpl = await ds.client.post(
        "/-/paper/api/docs", json={"name": "T", "kind": "template", "content": "# T\n"}
    )
    tmpl_id = tmpl.json()["id"]

    resp = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "X", "content": "# hi\n", "template_id": tmpl_id},
    )
    assert resp.status_code == 400
    assert "not both" in resp.json()["error"]


@pytest.mark.asyncio
async def test_create_content_must_be_string(ds):
    resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": "X", "content": {"not": "a string"}}
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_create_content_type_must_be_markdown(ds):
    resp = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "X", "content": "# hi\n", "content_type": "html"},
    )
    assert resp.status_code == 400
    assert "content_type" in resp.json()["error"]


@pytest.mark.asyncio
async def test_create_empty_content_yields_blank_doc(ds):
    resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Blank", "content": "   \n"}
    )
    assert resp.status_code == 201
    # Empty markdown → a single blank paragraph; document renders to just a
    # trailing newline.
    md = await _document_markdown(ds, resp.json()["id"])
    assert md == "\n"


@pytest.mark.asyncio
async def test_create_from_markdown_indexes_inline_tags(ds):
    """A markdown-seeded body flows straight into the version-0 snapshot,
    bypassing the instance write-tail. Create must still rebuild the derived
    `_datasette_paper_inline_tag` index, or `/tags/{slug}/refs` wouldn't see the
    doc until its first edit (regression: the tag-search page listed nothing)."""
    resp = await ds.client.post(
        "/-/paper/api/docs",
        json={
            "name": "Tagged",
            "content": "Filed under [#roadmap](paper:/tag/roadmap) twice: "
            "[#roadmap](paper:/tag/roadmap).\n",
        },
    )
    assert resp.status_code == 201, resp.text
    doc_id = resp.json()["id"]

    refs = await ds.client.get("/-/paper/api/tags/roadmap/refs")
    assert refs.status_code == 200, refs.text
    docs = refs.json()["docs"]
    assert [d["id"] for d in docs] == [doc_id]
    assert docs[0]["occurrences"] == 2


@pytest.mark.asyncio
async def test_create_from_markdown_indexes_links(ds):
    """Same write-tail bypass for outgoing `[[id]]` edges: a markdown-seeded
    doc must populate `_datasette_paper_link` so its target's backlinks list it
    without a first edit."""
    target = await ds.client.post("/-/paper/api/docs", json={"name": "Target"})
    target_id = target.json()["id"]

    src = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Source", "content": f"See [[{target_id}]] for context.\n"},
    )
    assert src.status_code == 201, src.text
    src_id = src.json()["id"]

    back = await ds.client.get(f"/-/paper/api/docs/{target_id}/backlinks")
    assert back.status_code == 200, back.text
    assert [b["id"] for b in back.json()["backlinks"]] == [src_id]
