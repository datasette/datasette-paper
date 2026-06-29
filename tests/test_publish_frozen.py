"""T05 — frozen data mode: bake query results at publish time.

Attaches a real `shop` database, publishes docs with frozen data blocks, and
asserts the results are baked into the static HTML (no live placeholders) and
stored in _datasette_paper_publication_data.
"""

from __future__ import annotations

import pytest

from tests.conftest import setup_paper_datasette


def _cookie(ds, actor_id: str) -> dict:
    return {"ds_actor": ds.sign({"a": {"id": actor_id}}, "actor")}


async def _setup_with_shop():
    ds, paper = await setup_paper_datasette()
    # Named memory DBs are shared process-wide, so reset the table to keep tests
    # isolated from one another.
    shop = ds.add_memory_database("shop")
    await shop.execute_write("drop table if exists sales")
    await shop.execute_write("create table sales (region text, n integer)")
    await shop.execute_write_many(
        "insert into sales (region, n) values (?, ?)",
        [("East", 20), ("West", 10)],
    )
    return ds, paper


async def _make_doc(ds, content: str) -> int:
    resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Frozen", "content": content}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


SQL_DOC = (
    "# Report\n\nNumbers:\n\n"
    "```sql db=shop\nselect region, n from sales order by region\n```\n"
)


@pytest.mark.asyncio
async def test_frozen_sql_bakes_rows_into_static_html():
    ds, paper = await _setup_with_shop()
    doc_id = await _make_doc(ds, SQL_DOC)

    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/publish",
        json={"data_mode_default": "frozen", "audience": [{"principal": "everyone"}]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["has_live_blocks"] is False
    assert body["blocks"][0]["mode"] == "frozen"

    # Frozen payload stored.
    data = await paper.select_publication_data(doc_id=doc_id, version=0)
    assert len(data) == 1
    assert data[0].kind == "sql"

    # The page is fully static: baked rows, no live placeholder, no hydrator.
    page = await ds.client.get(f"/-/paper/doc/{doc_id}/publish")
    assert page.status_code == 200
    html = page.text
    assert 'class="pm-data-table"' in html
    assert "<td>East</td>" in html and "<td>20</td>" in html
    assert "data-publish-live" not in html  # no live placeholders to hydrate
    assert "data as of" in html


@pytest.mark.asyncio
async def test_frozen_data_visible_without_viewer_sql_access():
    """The baked rows are server-rendered, so an audience member sees them with
    no client-side query (proving the data ran under the publisher, at publish
    time — not per viewer)."""
    ds, paper = await _setup_with_shop()
    doc_id = await _make_doc(ds, SQL_DOC)
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/publish",
        json={"data_mode_default": "frozen", "audience": [{"principal": "everyone"}]},
    )
    # Anonymous viewer (garbage cookie) still gets the baked rows.
    page = await ds.client.get(
        f"/-/paper/doc/{doc_id}/publish", cookies={"ds_actor": "nonsense"}
    )
    assert page.status_code == 200
    assert "<td>West</td>" in page.text


@pytest.mark.asyncio
async def test_per_block_override_beats_default():
    ds, paper = await _setup_with_shop()
    # Two SQL blocks → b0, b1. Default frozen, override b1 → live.
    content = (
        "# Two\n\n```sql db=shop\nselect n from sales order by region\n```\n\n"
        "```sql db=shop\nselect region from sales order by region\n```\n"
    )
    doc_id = await _make_doc(ds, content)
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/publish",
        json={
            "data_mode_default": "frozen",
            "block_overrides": {"b1": "live"},
            "audience": [{"principal": "everyone"}],
        },
    )
    body = resp.json()
    modes = {b["block_id"]: b["mode"] for b in body["blocks"]}
    assert modes == {"b0": "frozen", "b1": "live"}
    assert body["has_live_blocks"] is True

    html = (await ds.client.get(f"/-/paper/doc/{doc_id}/publish")).text
    # b0 baked (a table), b1 still a live placeholder.
    assert 'class="pm-data-table"' in html
    assert 'data-block-id="b1" data-publish-live="1"' in html


@pytest.mark.asyncio
async def test_frozen_inline_value_is_baked():
    ds, paper = await _setup_with_shop()
    content = (
        "# Snapshot\n\n"
        "```source name=tot db=shop\nselect sum(n) as total from sales\n```\n\n"
        "Total is ${{tot.total}} units.\n"
    )
    doc_id = await _make_doc(ds, content)
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/publish",
        json={"data_mode_default": "frozen", "audience": [{"principal": "everyone"}]},
    )
    assert resp.status_code == 200
    html = (await ds.client.get(f"/-/paper/doc/{doc_id}/publish")).text
    # The value atom is baked to the source's summed first-row cell (30).
    assert ">30</span>" in html
    assert "data-publish-live" not in html


@pytest.mark.asyncio
async def test_frozen_unbakeable_db_falls_back_to_live():
    ds, paper = await _setup_with_shop()
    # A SQL block against a nonexistent db → publisher can't run it → live.
    content = "# X\n\n```sql db=ghostdb\nselect 1\n```\n"
    doc_id = await _make_doc(ds, content)
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/publish",
        json={"data_mode_default": "frozen", "audience": [{"principal": "everyone"}]},
    )
    body = resp.json()
    assert body["blocks"][0]["mode"] == "live"
    assert body["has_live_blocks"] is True
    assert any(w["block_id"] == "b0" for w in body["warnings"])
