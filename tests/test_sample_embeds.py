"""Integration tests for the sample embed providers (tests/sample-plugin/).

Exercises the backend half of the custom-embed contract end to end: the
``paper_embed_provider`` manifest, the plugin serving its own JS bundles, the
per-viewer permission gating in its JSON routes (allowed / denied / the secret
404 leak-discipline case), the picker search filtering, and the manifest
reaching a real paper doc page. The JS half (resolve/mount rendering) is driven
by this same plugin under ``just dev`` / e2e.

The sample plugin is imported + ``pm.register``-ed for this module only (cleaner
than ``--plugins-dir`` here, which would double-register across tests).
"""

import importlib.util
import json
from pathlib import Path

import pytest
import pytest_asyncio
from datasette.app import Datasette
from datasette.plugins import pm

from datasette_paper.embed_providers import provider_manifest

SAMPLE = Path(__file__).parent / "sample-plugin" / "sample_embeds.py"

# Gotham actors (id + newsroom group), mirroring datasette-debug-gotham.
GOTHAM = {
    "clark": {"id": "clark", "newsroom": "daily-planet"},
    "lois": {"id": "lois", "newsroom": "daily-planet"},
    "bruce": {"id": "bruce", "newsroom": "gotham-gazette"},
}


@pytest.fixture(scope="module")
def sample_plugin():
    spec = importlib.util.spec_from_file_location("sample_embeds", SAMPLE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    pm.register(mod, name="sample-embeds-test")
    try:
        yield mod
    finally:
        pm.unregister(name="sample-embeds-test")


@pytest_asyncio.fixture
async def sds(sample_plugin):
    """A Datasette with paper + the sample plugin, paper-create granted."""
    ds = Datasette(
        memory=True, config={"permissions": {"datasette-paper-create": True}}
    )
    await ds.invoke_startup()
    return ds


def actor_cookies(ds, actor_id):
    return {"ds_actor": ds.sign({"a": GOTHAM[actor_id]}, "actor")}


# ---------------------------------------------------------------------------
# Manifest + asset serving
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_manifest_includes_both_sample_providers(sds):
    by_kind = {e["kind"]: e for e in provider_manifest(sds)}
    assert {"playlist", "widget"} <= set(by_kind)
    assert by_kind["playlist"]["ref_prefixes"] == ["/-/sample-embeds/playlists/"]
    assert by_kind["playlist"]["js"] == ["/-/sample-embeds/playlists.js"]
    assert by_kind["playlist"]["sources"] == [
        {"id": "playlist", "label": "Playlists", "icon": "database"}
    ]
    assert by_kind["widget"]["ref_prefixes"] == ["/-/sample-embeds/widgets/"]


@pytest.mark.asyncio
async def test_js_bundles_are_served(sds):
    for url in ("/-/sample-embeds/playlists.js", "/-/sample-embeds/widgets.js"):
        r = await sds.client.get(url)
        assert r.status_code == 200
        assert "javascript" in r.headers["content-type"]
        assert "datasettePaperEmbeds" in r.text


# ---------------------------------------------------------------------------
# Playlist permissions (denied = 403; existence is fine to reveal)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_playlist_visible_to_owner_newsroom_and_public(sds):
    pl = "/-/sample-embeds/playlists/summer-mix.json"
    # Owner (clark) and a newsroom peer (lois) both see it.
    r = await sds.client.get(pl, cookies=actor_cookies(sds, "clark"))
    assert r.status_code == 200
    assert r.json()["title"] == "Summer Road-Trip Mix"
    assert len(r.json()["tracks"]) == 4
    assert (
        await sds.client.get(pl, cookies=actor_cookies(sds, "lois"))
    ).status_code == 200
    # A different newsroom (bruce) is denied.
    assert (
        await sds.client.get(pl, cookies=actor_cookies(sds, "bruce"))
    ).status_code == 403
    # Anonymous is denied.
    assert (await sds.client.get(pl)).status_code == 403
    # The public playlist is visible to any signed-in actor (bruce).
    pub = "/-/sample-embeds/playlists/front-page-hits.json"
    assert (
        await sds.client.get(pub, cookies=actor_cookies(sds, "bruce"))
    ).status_code == 200


@pytest.mark.asyncio
async def test_missing_playlist_is_404(sds):
    r = await sds.client.get(
        "/-/sample-embeds/playlists/nope.json", cookies=actor_cookies(sds, "clark")
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Widget leak discipline (secret → 404; known-but-forbidden → 403)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_secret_widget_404s_for_non_owner(sds):
    bat = "/-/sample-embeds/widgets/bat-signal.json"
    # Owner sees the gauge.
    r = await sds.client.get(bat, cookies=actor_cookies(sds, "bruce"))
    assert r.status_code == 200
    assert r.json()["value"] == 73
    # Everyone else gets 404 — never learns it exists (NOT 403).
    assert (
        await sds.client.get(bat, cookies=actor_cookies(sds, "clark"))
    ).status_code == 404
    assert (await sds.client.get(bat)).status_code == 404


@pytest.mark.asyncio
async def test_known_widget_403s_when_forbidden(sds):
    pp = "/-/sample-embeds/widgets/press-pass.json"
    # daily-planet sees the badge.
    r = await sds.client.get(pp, cookies=actor_cookies(sds, "clark"))
    assert r.status_code == 200
    assert r.json()["color"] == "#1d4ed8"
    # gotham-gazette is forbidden but the resource is not secret → 403.
    assert (
        await sds.client.get(pp, cookies=actor_cookies(sds, "bruce"))
    ).status_code == 403
    # Public gauge visible to any signed-in actor.
    ns = "/-/sample-embeds/widgets/newsstand.json"
    assert (
        await sds.client.get(ns, cookies=actor_cookies(sds, "bruce"))
    ).status_code == 200


# ---------------------------------------------------------------------------
# Picker search is viewer-filtered (never lists what you can't see)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_search_filters_to_visible(sds):
    r = await sds.client.get(
        "/-/sample-embeds/playlists.json", cookies=actor_cookies(sds, "clark")
    )
    refs = [h["ref"] for h in r.json()["results"]]
    assert "/-/sample-embeds/playlists/summer-mix" in refs
    assert "/-/sample-embeds/playlists/front-page-hits" in refs  # public
    assert "/-/sample-embeds/playlists/gotham-nights" not in refs  # other newsroom

    # clark must NOT see the secret bat-signal in widget search; bruce does.
    r_clark = await sds.client.get(
        "/-/sample-embeds/widgets.json", cookies=actor_cookies(sds, "clark")
    )
    clark_refs = [h["ref"] for h in r_clark.json()["results"]]
    assert "/-/sample-embeds/widgets/bat-signal" not in clark_refs
    assert "/-/sample-embeds/widgets/press-pass" in clark_refs
    r_bruce = await sds.client.get(
        "/-/sample-embeds/widgets.json", cookies=actor_cookies(sds, "bruce")
    )
    assert "/-/sample-embeds/widgets/bat-signal" in [
        h["ref"] for h in r_bruce.json()["results"]
    ]


# ---------------------------------------------------------------------------
# The manifest reaches a real paper doc page (so the editor lazy-loads it)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_sample_manifest_on_doc_page(sds):
    created = await sds.client.post(
        "/-/paper/api/docs",
        json={"name": "Embeds demo"},
        cookies=actor_cookies(sds, "clark"),
    )
    assert created.status_code == 201
    doc_id = created.json()["id"]
    resp = await sds.client.get(
        f"/-/paper/doc/{doc_id}", cookies=actor_cookies(sds, "clark")
    )
    assert resp.status_code == 200
    start = resp.text.index('id="pageData">') + len('id="pageData">')
    end = resp.text.index("</script>", start)
    page_data = json.loads(resp.text[start:end])
    kinds = {e["kind"] for e in page_data["embed_providers"]}
    assert {"playlist", "widget"} <= kinds
