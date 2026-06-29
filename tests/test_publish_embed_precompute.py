"""T06 — paper_embed_provider.precompute: freezing custom-provider embeds.

Registers reference providers (one with a `precompute` method, one without) and
asserts a frozen custom embed bakes its precomputed payload, while a provider
without `precompute` falls back to live with a warning.
"""

from __future__ import annotations

import json

import pytest
from datasette import hookimpl
from datasette.plugins import pm

from tests.conftest import setup_paper_datasette


class _WithPrecompute:
    kind = "demo"
    ref_prefixes = ["demo:"]

    def frontend_assets(self, datasette):
        return {"js": []}

    def precompute(self, datasette, ref, config, actor):
        # Tabular payload → renders through the frozen results-table path.
        return {"columns": ["k", "v"], "rows": [["a", 1], ["b", 2]]}


class _WithoutPrecompute:
    kind = "plain"
    ref_prefixes = ["plain:"]

    def frontend_assets(self, datasette):
        return {"js": []}


class _DemoPlugin:
    @hookimpl
    def paper_embed_provider(self, datasette):
        return [_WithPrecompute(), _WithoutPrecompute()]


def _doc_with_embed(ref: str) -> str:
    return json.dumps(
        {
            "type": "doc",
            "content": [
                {
                    "type": "heading",
                    "attrs": {"level": 1},
                    "content": [{"type": "text", "text": "Custom"}],
                },
                {
                    "type": "block_embed",
                    "attrs": {"ref": ref, "mode": "table", "config": {}},
                },
            ],
        }
    )


@pytest.fixture
def demo_provider():
    plugin = _DemoPlugin()
    pm.register(plugin, name="paper-precompute-test")
    try:
        yield
    finally:
        pm.unregister(plugin)


async def _doc_with_snapshot(ds, paper, doc_json: str) -> int:
    from datasette_paper.permissions import seed_owner_manager_grant

    doc = await paper.insert_doc(name="embed", created_by="alice")
    await paper.insert_snapshot(
        doc_id=doc.id, version=0, doc_json=doc_json, actor_id="alice"
    )
    # The create *route* seeds the owner Manager grant; we bypass it here, so do
    # it explicitly (publishing gates on paper-manage).
    await seed_owner_manager_grant(ds, doc.id, "alice")
    return doc.id


@pytest.mark.asyncio
async def test_custom_embed_with_precompute_is_baked(demo_provider):
    ds, paper = await setup_paper_datasette()
    doc_id = await _doc_with_snapshot(ds, paper, _doc_with_embed("demo:/chart"))

    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/publish",
        json={"data_mode_default": "frozen", "audience": [{"principal": "everyone"}]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["blocks"][0]["mode"] == "frozen"
    assert body["has_live_blocks"] is False
    assert body["warnings"] == []

    # Baked payload stored + rendered.
    data = await paper.select_publication_data(doc_id=doc_id, version=0)
    assert json.loads(data[0].payload_json)["rows"] == [["a", 1], ["b", 2]]
    html = (await ds.client.get(f"/-/paper/doc/{doc_id}/publish")).text
    assert "<th>k</th>" in html and "<td>a</td>" in html
    assert "data-publish-live" not in html


@pytest.mark.asyncio
async def test_custom_embed_without_precompute_falls_back_to_live(demo_provider):
    ds, paper = await setup_paper_datasette()
    doc_id = await _doc_with_snapshot(ds, paper, _doc_with_embed("plain:/widget"))

    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/publish",
        json={"data_mode_default": "frozen", "audience": [{"principal": "everyone"}]},
    )
    body = resp.json()
    assert body["blocks"][0]["mode"] == "live"
    assert body["has_live_blocks"] is True
    assert any(w["block_id"] == "b0" for w in body["warnings"])
    html = (await ds.client.get(f"/-/paper/doc/{doc_id}/publish")).text
    assert 'data-block-embed="plain:/widget" data-embed-mode="table"' in html
    assert "data-publish-live" in html
