"""Tests for the installable-PWA surface: manifest, head tags, and icons.

@feat pwa: proves the manifest route, the paper_base head tags, and the
packaged icons all serve correctly so /-/paper/ is installable.
"""

import pytest


@pytest.mark.asyncio
async def test_manifest_served(ds):
    r = await ds.client.get("/-/paper/manifest.webmanifest")
    assert r.status_code == 200
    # Exactly one, correct media type — no appended second Content-Type header.
    assert r.headers["content-type"] == "application/manifest+json"
    body = r.json()
    assert body["name"] == "Papers"
    assert body["display"] == "standalone"
    assert body["start_url"].endswith("/-/paper/")
    assert body["scope"].endswith("/-/paper/")
    # theme/background kept in lock-step with the paper_base.html meta tag.
    assert body["theme_color"] == "#ffffff"
    assert any(i.get("purpose") == "maskable" for i in body["icons"]), (
        "manifest must advertise a maskable icon"
    )
    # Every icon URL the manifest points at must actually resolve.
    for entry in body["icons"]:
        icon = await ds.client.get(entry["src"])
        assert icon.status_code == 200, entry["src"]
        assert icon.headers["content-type"] == "image/png"


@pytest.mark.asyncio
async def test_manifest_ungated(ds):
    """The manifest carries no actor-specific data — anonymous 200."""
    r = await ds.client.get("/-/paper/manifest.webmanifest", cookies={"ds_actor": ""})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_index_head_has_pwa_tags(ds):
    html = (await ds.client.get("/-/paper/")).text
    assert 'rel="manifest"' in html
    assert "/-/paper/manifest.webmanifest" in html
    assert 'name="theme-color" content="#ffffff"' in html
    assert 'name="apple-mobile-web-app-capable"' in html
    assert 'name="apple-mobile-web-app-title" content="Papers"' in html
    assert 'rel="apple-touch-icon"' in html
    assert "icons/apple-touch-icon.png" in html


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name",
    [
        "apple-touch-icon.png",
        "icon-192.png",
        "icon-512.png",
        "icon-maskable-512.png",
    ],
)
async def test_icons_served(ds, name):
    r = await ds.client.get(f"/-/static-plugins/datasette_paper/icons/{name}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
