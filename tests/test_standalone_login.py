"""Tests for the one-off local-login plugin + instance factory in
``datasette_paper.cli.standalone`` (ticket 01 of ``plans/cli-top``).

``LocalLoginPlugin`` is registered programmatically (never shipped as part
of the ``datasette-paper`` plugin proper), so every test here registers it
via ``pm.register`` and unregisters in teardown — a leaked registration
would pollute every other test in the session (see ``tests/CLAUDE.md`` /
``plans/cli-top/README.md`` "Risks").
"""

# @feat cli-top: tests for the local-login plugin (token check, cookie,
# create-permission gating) and secret persistence across relaunches.

import pytest
import pytest_asyncio
from datasette.plugins import pm

from conftest import actor_cookie
from datasette_paper.cli.standalone import (
    LocalLoginPlugin,
    build_instance,
    load_or_create_secret,
    secret_path,
)


ACTOR_ID = "alice"
TOKEN = "the-launch-token"


@pytest_asyncio.fixture
async def ds_with_login(tmp_path):
    """A composed instance (ticket 01 factory) with the login plugin registered."""
    ds = build_instance(
        internal_db_path=tmp_path / "internal.db",
        user_dbs=[],
        user_id=ACTOR_ID,
        secret="fixed-test-secret",
    )
    await ds.invoke_startup()
    plugin = LocalLoginPlugin(ACTOR_ID, TOKEN)
    pm.register(plugin, name="paper-local-login-test")
    try:
        yield ds
    finally:
        pm.unregister(plugin)


@pytest.mark.asyncio
async def test_correct_token_sets_cookie_and_redirects(ds_with_login):
    ds = ds_with_login
    resp = await ds.client.get(
        f"/-/paper-local-login?token={TOKEN}", follow_redirects=False
    )
    assert resp.status_code == 302
    assert resp.headers["location"] == "/-/paper/"
    set_cookie = resp.headers.get("set-cookie", "")
    assert "ds_actor=" in set_cookie

    # Extract the cookie value and use it on a follow-up request.
    cookie_value = resp.cookies["ds_actor"]
    actor_resp = await ds.client.get(
        "/-/actor.json", cookies={"ds_actor": cookie_value}
    )
    assert actor_resp.status_code == 200
    assert actor_resp.json()["actor"]["id"] == ACTOR_ID


@pytest.mark.asyncio
async def test_wrong_token_is_forbidden(ds_with_login):
    ds = ds_with_login
    resp = await ds.client.get("/-/paper-local-login?token=nope")
    assert resp.status_code == 403
    assert "set-cookie" not in resp.headers


@pytest.mark.asyncio
async def test_missing_token_is_forbidden(ds_with_login):
    ds = ds_with_login
    resp = await ds.client.get("/-/paper-local-login")
    assert resp.status_code == 403
    assert "set-cookie" not in resp.headers


@pytest.mark.asyncio
async def test_composed_config_gates_create_to_launch_actor(ds_with_login):
    ds = ds_with_login

    resp = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Hello"},
        cookies=actor_cookie(ds, ACTOR_ID),
    )
    assert resp.status_code == 201, resp.text
    doc_id = resp.json()["id"]

    # The seeded owner Manager grant lets the same actor read it back.
    fetch = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}",
        cookies=actor_cookie(ds, ACTOR_ID),
    )
    assert fetch.status_code == 200, fetch.text

    # Anonymous requests can't create.
    anon_resp = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Nope"},
    )
    assert anon_resp.status_code == 403


# ---------------------------------------------------------------------------
# next_path (ticket 03): the first-launch welcome-doc redirect target.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_custom_next_path_redirects_there(tmp_path):
    """A non-default `next_path` (the CLI's first-launch welcome-doc
    redirect) is honored instead of the `/-/paper/` default."""
    ds = build_instance(
        internal_db_path=tmp_path / "internal.db",
        user_dbs=[],
        user_id=ACTOR_ID,
        secret="fixed-test-secret",
    )
    await ds.invoke_startup()
    plugin = LocalLoginPlugin(ACTOR_ID, TOKEN, next_path="/-/paper/doc/42")
    pm.register(plugin, name="paper-local-login-test-next-path")
    try:
        resp = await ds.client.get(
            f"/-/paper-local-login?token={TOKEN}", follow_redirects=False
        )
        assert resp.status_code == 302
        assert resp.headers["location"] == "/-/paper/doc/42"
    finally:
        pm.unregister(plugin)


@pytest.mark.parametrize(
    "bad_next_path", ["", "no-leading-slash", "//evil.example.com"]
)
def test_next_path_must_be_same_origin(bad_next_path):
    with pytest.raises(ValueError):
        LocalLoginPlugin(ACTOR_ID, TOKEN, next_path=bad_next_path)


@pytest.mark.asyncio
async def test_secret_persists_across_relaunches(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))

    secret_a = load_or_create_secret()
    secret_b = load_or_create_secret()
    assert secret_a == secret_b
    assert secret_path() == tmp_path / ".datasette" / "internal-paper.secret"
    assert secret_path().stat().st_mode & 0o777 == 0o600

    ds_a = build_instance(
        internal_db_path=tmp_path / "a.db",
        user_dbs=[],
        user_id=ACTOR_ID,
        secret=secret_a,
    )
    await ds_a.invoke_startup()
    ds_b = build_instance(
        internal_db_path=tmp_path / "b.db",
        user_dbs=[],
        user_id=ACTOR_ID,
        secret=secret_b,
    )
    await ds_b.invoke_startup()

    # A cookie signed under the first instance validates under the second —
    # both were built with the same persisted secret.
    cookie = ds_a.sign({"a": {"id": ACTOR_ID}}, "actor")
    resp = await ds_b.client.get("/-/actor.json", cookies={"ds_actor": cookie})
    assert resp.status_code == 200
    assert resp.json()["actor"]["id"] == ACTOR_ID
