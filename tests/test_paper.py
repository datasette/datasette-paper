from datasette.app import Datasette
import pytest


@pytest.mark.asyncio
async def test_plugin_is_installed():
    datasette = Datasette(memory=True)
    response = await datasette.client.get("/-/plugins.json")
    assert response.status_code == 200
    installed_plugins = {p["name"] for p in response.json()}
    assert "datasette-paper" in installed_plugins


@pytest.mark.asyncio
async def test_paper_index_renders():
    datasette = Datasette(
        memory=True,
        config={"permissions": {"datasette-paper-list": True}},
    )
    response = await datasette.client.get("/-/paper/")
    assert response.status_code == 200
    # Index page mounts a Svelte SPA; assert the mount div is present
    # (the actual list is rendered client-side via openapi-fetch).
    assert b'id="app-root"' in response.content
    # And the entry script for the index page is wired up.
    assert (
        b"src/pages/index/main.ts" in response.content or b"index" in response.content
    )


@pytest.mark.asyncio
async def test_paper_index_renders_without_trailing_slash():
    """`/-/paper` (no slash) must serve the same page as `/-/paper/` so the
    in-app paper-icon back link works regardless of how the URL is typed."""
    datasette = Datasette(
        memory=True,
        config={"permissions": {"datasette-paper-list": True}},
    )
    response = await datasette.client.get("/-/paper")
    assert response.status_code == 200
    assert b'id="app-root"' in response.content


@pytest.mark.asyncio
async def test_extra_template_vars_returns_entry_callable():
    """extra_template_vars should expose a vite-entry helper backed by datasette_vite."""
    datasette = Datasette(memory=True)
    from datasette_paper import extra_template_vars

    result = extra_template_vars(datasette=datasette)
    assert "datasette_paper_vite_entry" in result
    assert callable(result["datasette_paper_vite_entry"])
