"""Tests for the profile "Papers" integration: the docs endpoint + hookimpl.

The `_datasette_paper_doc_activity` data layer these build on (T01) is
covered by tests/test_doc_activity.py; this file covers the HTTP endpoint
(T02) and the `datasette_user_profile_sections` registration (T04).
"""

import asyncio

import pytest
from datasette.app import Datasette

from datasette_paper.db import PaperDB

from datasette_paper import datasette_user_profile_sections

from conftest import (  # noqa: E402  (sibling helper)
    actor_cookie,
    build_ds,
    create_doc,
    grant_role,
    setup_paper_datasette,
)


# ---------------------------------------------------------------------------
# Route: GET /-/paper/api/profile/<actor>/docs (T02)
#
# @feat profile-papers: the HTTP endpoint the profile web component calls —
# profile actor's created/recently-edited active docs ∩ the viewer's
# paper-view set, ungated + acl-filtered (list_docs precedent), unknown actor
# → 200 empty, ?limit clamped 1..25.
# ---------------------------------------------------------------------------


async def _profile_docs(ds, viewer, actor, query=""):
    """GET the endpoint as `viewer`, return (status, parsed json)."""
    url = f"/-/paper/api/profile/{actor}/docs{query}"
    resp = await ds.client.get(url, cookies=actor_cookie(ds, viewer))
    return resp.status_code, resp.json()


@pytest.mark.asyncio
async def test_route_permission_matrix():
    """Viewer V sees exactly {A, B}: A created-by P (created=true), B edited-by
    P (created=false, last_edited_at set). C hidden by acl, D has no P
    attribution, E is trashed. Ordering: B (edit) beats A (created_at)."""
    ds, paper = await setup_paper_datasette()

    # A: created by P, viewer can view.
    a = await create_doc(ds, "A", actor_id="pat")
    await grant_role(ds, a, "vic")
    # B: created by someone else, edited by P, viewer can view.
    b = await create_doc(ds, "B", actor_id="other")
    await grant_role(ds, b, "vic")
    # P's edit stamp must sort ahead of A's created_at; stamps have
    # millisecond precision, so a 2ms sleep keeps it strictly later.
    await asyncio.sleep(0.002)
    await paper.insert_step(doc_id=b, client_id=1, actor_id="pat", step_json="{}")
    # C: created by P but viewer has NO grant.
    await create_doc(ds, "C", actor_id="pat")
    # D: edited only by someone else (no P attribution), viewer can view.
    d = await create_doc(ds, "D", actor_id="other")
    await grant_role(ds, d, "vic")
    await paper.insert_step(doc_id=d, client_id=1, actor_id="zed", step_json="{}")
    # E: created by P, viewer can view, but trashed (inactive).
    e = await create_doc(ds, "E", actor_id="pat")
    await grant_role(ds, e, "vic")
    await paper.trash_doc(doc_id=e, delete_at="2099-12-31T00:00:00.000Z")

    status, body = await _profile_docs(ds, "vic", "pat")
    assert status == 200
    docs = body["docs"]
    # Exactly {A, B}, B first (activity beats created_at).
    assert [row["name"] for row in docs] == ["B", "A"]

    by_name = {row["name"]: row for row in docs}
    assert by_name["A"]["created"] is True
    assert by_name["A"]["last_edited_at"] is None
    assert by_name["A"]["url"] == f"/-/paper/doc/{a}"

    assert by_name["B"]["created"] is False
    assert by_name["B"]["last_edited_at"] > by_name["A"]["created_at"]
    assert by_name["B"]["url"] == f"/-/paper/doc/{b}"
    # created_at / updated_at present on every row.
    assert by_name["B"]["created_at"] and by_name["B"]["updated_at"]


@pytest.mark.asyncio
async def test_route_limit_low_clamp():
    """?limit=1 returns a single row even when more are visible."""
    ds, paper = await setup_paper_datasette()
    for name in ("A", "B", "C"):
        doc = await create_doc(ds, name, actor_id="pat")
        await grant_role(ds, doc, "vic")

    status, body = await _profile_docs(ds, "vic", "pat", "?limit=1")
    assert status == 200
    assert len(body["docs"]) == 1


@pytest.mark.asyncio
async def test_route_limit_high_clamp(monkeypatch):
    """?limit=999 is clamped to the 25 cap before hitting the data layer."""
    ds, paper = await setup_paper_datasette()
    a = await create_doc(ds, "A", actor_id="pat")
    await grant_role(ds, a, "vic")

    captured = {}
    orig = PaperDB.list_profile_docs

    async def spy(self, *, doc_ids, actor, limit):
        captured["limit"] = limit
        return await orig(self, doc_ids=doc_ids, actor=actor, limit=limit)

    monkeypatch.setattr(PaperDB, "list_profile_docs", spy)

    status, body = await _profile_docs(ds, "vic", "pat", "?limit=999")
    assert status == 200
    assert captured["limit"] == 25


@pytest.mark.asyncio
async def test_route_unknown_actor_is_empty():
    """A never-seen profile actor → 200 {"docs": []} (no existence oracle),
    even though the viewer has visible docs of their own."""
    ds, paper = await setup_paper_datasette()
    doc = await create_doc(ds, "A", actor_id="pat")
    await grant_role(ds, doc, "vic")

    status, body = await _profile_docs(ds, "vic", "nobody-here")
    assert status == 200
    assert body == {"docs": []}


@pytest.mark.asyncio
async def test_route_viewer_with_no_grants_is_empty():
    """A viewer holding no paper-view grants → 200 {"docs": []} (short-circuit
    on the empty visible set, also the anonymous-on-locked-down-instance path)."""
    ds, paper = await setup_paper_datasette()
    doc = await create_doc(ds, "A", actor_id="pat")
    await grant_role(ds, doc, "vic")  # granted to vic, NOT to stranger

    status, body = await _profile_docs(ds, "stranger", "pat")
    assert status == 200
    assert body == {"docs": []}


@pytest.mark.asyncio
async def test_route_actor_id_url_encoded_round_trips():
    """An actor id needing URL-encoding (a space) round-trips through the route
    regex and matches created_by for the `created` flag."""
    ds, paper = await setup_paper_datasette()
    doc = await create_doc(ds, "A", actor_id="pat smith")
    await grant_role(ds, doc, "vic")

    status, body = await _profile_docs(ds, "vic", "pat%20smith")
    assert status == 200
    assert [row["name"] for row in body["docs"]] == ["A"]
    assert body["docs"][0]["created"] is True


# ---------------------------------------------------------------------------
# Hookimpl: datasette_user_profile_sections (T04)
#
# @feat profile-papers: registers the "Papers" section on user-profiles pages —
# the hookimpl returns one ProfileSection(id="papers", tag_name="profile-papers")
# whose js/css come from the built Vite bundle, so the profile page loads it and
# renders <profile-papers>.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_profile_section_registered():
    """The hook returns exactly one Papers section with the expected identity.

    Invoked through Datasette's plugin manager (kanban's
    test_user_profile_section_registered is the model)."""
    from datasette.plugins import pm

    ds = Datasette(memory=True)
    results = pm.hook.datasette_user_profile_sections(datasette=ds)
    sections = [s for result in results if result for s in result]
    papers = [s for s in sections if s.id == "papers"]
    assert len(papers) == 1
    section = papers[0]
    assert section.tag_name == "profile-papers"
    assert section.label == "Papers"
    assert section.sort_order == 40
    assert section.icon is not None and "currentColor" in section.icon


@pytest.mark.asyncio
async def test_profile_section_asset_urls_resolve():
    """Every js/css URL points under the plugin's static dir and GETs 200 — a
    404 here means the entrypoint key went stale against manifest.json."""
    ds, _ = await setup_paper_datasette()
    (section,) = datasette_user_profile_sections(ds)

    urls = section.all_js_urls() + section.all_css_urls()
    assert urls, "expected at least one built js/css asset"
    prefix = "/-/static-plugins/datasette_paper/"
    for url in urls:
        assert url.startswith(prefix), url
        resp = await ds.client.get(url)
        assert resp.status_code == 200, f"{url} -> {resp.status_code}"


@pytest.mark.asyncio
async def test_profile_page_renders_papers_section():
    """Full-stack smoke: the user-profiles profile page embeds the section's
    tag_name and bundle URL in its page data (user-profiles is a hard dep, so
    its routes are live). profile_access is granted the way the profiles
    plugin's own surface requires — an authenticated actor with the perm."""
    ds = await build_ds(
        config={
            "permissions": {
                "datasette-paper-create": True,
                "profile_access": True,
            }
        }
    )
    section = datasette_user_profile_sections(ds)[0]
    bundle_url = section.all_js_urls()[0]

    resp = await ds.client.get("/-/profile/pat", cookies=actor_cookie(ds, "vic"))
    assert resp.status_code == 200, resp.text
    assert "profile-papers" in resp.text
    assert bundle_url in resp.text
