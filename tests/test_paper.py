from datasette.app import Datasette
import pytest


@pytest.mark.asyncio
async def test_plugin_is_installed():
    datasette = Datasette(memory=True)
    response = await datasette.client.get("/-/plugins.json")
    assert response.status_code == 200
    # Datasette >=1.0a36 wraps the list in {"ok", "plugins"}; older
    # releases returned a bare list.
    payload = response.json()
    plugins = payload["plugins"] if isinstance(payload, dict) else payload
    installed_plugins = {p["name"] for p in plugins}
    assert "datasette-paper" in installed_plugins


@pytest.mark.asyncio
async def test_paper_index_renders():
    datasette = Datasette(
        memory=True,
        config={"permissions": {}},
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
        config={"permissions": {}},
    )
    response = await datasette.client.get("/-/paper")
    assert response.status_code == 200
    assert b'id="app-root"' in response.content


@pytest.mark.asyncio
async def test_paper_todos_page_renders():
    """@feat task-assign: the /-/paper/todos shell mounts the todos entry and
    carries the signed-in actor id in its page data (or null for anonymous)."""
    datasette = Datasette(memory=True, config={"permissions": {}})

    # Anonymous → page renders with a null default actor. The vite helper
    # resolves the entry to the built, content-hashed `todos-*` asset.
    response = await datasette.client.get("/-/paper/todos")
    assert response.status_code == 200
    assert b'id="app-root"' in response.content
    assert b"todos" in response.content
    assert b'"actor_id": null' in response.content

    # Signed-in → the actor id rides in the page data as the default subject.
    cookie = datasette.sign({"a": {"id": "pat"}}, "actor")
    response = await datasette.client.get(
        "/-/paper/todos", cookies={"ds_actor": cookie}
    )
    assert response.status_code == 200
    assert b'"actor_id": "pat"' in response.content


@pytest.mark.asyncio
async def test_extra_template_vars_returns_entry_callable():
    """extra_template_vars should expose a vite-entry helper backed by datasette_vite."""
    datasette = Datasette(memory=True)
    from datasette_paper import extra_template_vars

    result = extra_template_vars(datasette=datasette)
    assert "datasette_paper_vite_entry" in result
    assert callable(result["datasette_paper_vite_entry"])
