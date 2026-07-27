"""Tests for the `datasette-paper` standalone launcher's CLI surface
(ticket 02 of ``plans/cli-top``): ``split_argv``, defaults, the ``main``
click command, and the pre-existing-db warning check.

No uvicorn, no real browser: ``uvicorn.run`` / ``webbrowser.open`` are
monkeypatched everywhere ``main``/``launch`` actually runs. Anything that
needs an event loop of its own (``launch`` uses ``datasette.cli.run_sync``,
which creates a *fresh* loop) is exercised from a plain, non-``asyncio``
test function — calling it from inside an already-running
``pytest-asyncio`` loop would hit "Cannot run the event loop while another
loop is running". Async setup steps (seeding a db) use ``run_sync``
themselves, in a separate call that fully completes before ``CliRunner``
runs.
"""

# @feat cli-top: CLI-surface tests — argv splitting, defaults, the launch
# flow (smoke + missing-user-db), and the pre-existing-db warning.

from urllib.parse import urlsplit

import click.testing
import pytest
from datasette.app import Datasette
from datasette.cli import run_sync
from datasette.plugins import pm

from datasette_paper.cli import standalone
from datasette_paper.cli.standalone import (
    default_internal_db_path,
    main,
    split_argv,
)


def _unregister_login_plugin():
    """Undo `launch()`'s `pm.register(..., name="paper-local-login")`.

    A real `datasette-paper` invocation only ever runs once per process — the
    registration is meant to live for the process lifetime. A test that
    invokes `main` twice (simulating two separate launches against the same
    tmp home) needs to unregister between calls or the second `pm.register`
    under the same fixed name raises.
    """
    existing = pm.get_plugin("paper-local-login")
    if existing is not None:
        pm.unregister(existing)


def _path_and_query(url: str) -> str:
    parts = urlsplit(url)
    return parts.path + (f"?{parts.query}" if parts.query else "")


@pytest.fixture(autouse=True)
def _cleanup_login_plugin():
    """``launch()`` registers under a fixed name — never leave it behind."""
    yield
    existing = pm.get_plugin("paper-local-login")
    if existing is not None:
        pm.unregister(existing)


# ---------------------------------------------------------------------------
# split_argv — pure, no click involved.
# ---------------------------------------------------------------------------


def test_split_argv_no_separator():
    ours, user_dbs = split_argv(["internal.db", "-p", "9000"])
    assert ours == ["internal.db", "-p", "9000"]
    assert user_dbs == []


def test_split_argv_leading_separator():
    ours, user_dbs = split_argv(["--", "a.db", "b.db"])
    assert ours == []
    assert user_dbs == ["a.db", "b.db"]


def test_split_argv_flags_and_positional_before_separator():
    ours, user_dbs = split_argv(["internal.db", "-p", "9000", "--", "a.db"])
    assert ours == ["internal.db", "-p", "9000"]
    assert user_dbs == ["a.db"]


def test_split_argv_second_separator_stays_in_user_dbs():
    ours, user_dbs = split_argv(["--", "a.db", "--", "b.db"])
    assert ours == []
    assert user_dbs == ["a.db", "--", "b.db"]


# ---------------------------------------------------------------------------
# Defaults.
# ---------------------------------------------------------------------------


def test_default_internal_db_path_under_home(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert default_internal_db_path() == tmp_path / ".datasette" / "internal-paper.db"


def test_port_and_host_option_defaults():
    by_name = {p.name: p for p in main.params}
    assert by_name["port"].default == 8001
    assert by_name["host"].default == "127.0.0.1"
    assert by_name["port"].show_default is True
    assert by_name["host"].show_default is True


# ---------------------------------------------------------------------------
# `main` smoke tests — uvicorn.run / webbrowser.open monkeypatched.
# ---------------------------------------------------------------------------


def _patch_launch_boundaries(monkeypatch, *, actor_id="testuser"):
    """Stub out uvicorn/webbrowser and pin the actor id; return a dict of
    captured calls (`uvicorn_kwargs`, `opened_url`) plus a spy on
    `build_instance` (`build_calls`, appended-to list of kwargs) so tests
    can inspect what the composed Datasette instance actually got."""
    import uvicorn
    import webbrowser

    captured = {"build_calls": []}

    def fake_uvicorn_run(app, **kwargs):
        captured["uvicorn_kwargs"] = kwargs

    def fake_webbrowser_open(url):
        captured["opened_url"] = url
        return True

    real_build_instance = standalone.build_instance

    def spy_build_instance(**kwargs):
        ds = real_build_instance(**kwargs)
        captured["build_calls"].append(kwargs)
        captured["ds"] = ds
        return ds

    monkeypatch.setattr(uvicorn, "run", fake_uvicorn_run)
    monkeypatch.setattr(webbrowser, "open", fake_webbrowser_open)
    monkeypatch.setattr(standalone, "get_actor_id", lambda: actor_id)
    monkeypatch.setattr(standalone, "build_instance", spy_build_instance)
    return captured


def test_main_smoke_user_dbs_and_login_url(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    captured = _patch_launch_boundaries(monkeypatch)

    internal_db = tmp_path / "internal.db"
    user_db = tmp_path / "mydata.db"
    user_db.write_text("")

    runner = click.testing.CliRunner()
    result = runner.invoke(
        main,
        [str(internal_db), "-p", "9123", "-h", "0.0.0.0", "--", str(user_db)],
    )
    assert result.exit_code == 0, result.output

    # User DBs after `--` reached the composed instance's files.
    assert captured["build_calls"][0]["user_dbs"] == [str(user_db)]
    assert captured["ds"].files == (str(user_db),)

    # uvicorn received the composed host/port.
    assert captured["uvicorn_kwargs"]["host"] == "0.0.0.0"
    assert captured["uvicorn_kwargs"]["port"] == 9123

    # The opened URL is the login route on the chosen host:port, carrying
    # a token — and the same URL was echoed to the terminal.
    opened = captured["opened_url"]
    assert opened.startswith("http://0.0.0.0:9123/-/paper-local-login?token=")
    assert opened in result.output


def test_main_no_internal_db_positional_uses_default_under_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    captured = _patch_launch_boundaries(monkeypatch)

    runner = click.testing.CliRunner()
    result = runner.invoke(main, [])
    assert result.exit_code == 0, result.output

    expected = home / ".datasette" / "internal-paper.db"
    assert captured["build_calls"][0]["internal_db_path"] == expected
    assert expected.parent.is_dir()


def test_main_explicit_internal_db_overrides_default_and_neednt_exist(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    captured = _patch_launch_boundaries(monkeypatch)

    custom = tmp_path / "somewhere" / "custom.db"
    assert not custom.exists()

    runner = click.testing.CliRunner()
    result = runner.invoke(main, [str(custom)])
    assert result.exit_code == 0, result.output
    assert captured["build_calls"][0]["internal_db_path"] == custom


def test_main_missing_user_db_is_usage_error(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    _patch_launch_boundaries(monkeypatch)

    missing = tmp_path / "does-not-exist.db"
    runner = click.testing.CliRunner()
    result = runner.invoke(main, ["--", str(missing)])

    assert result.exit_code != 0
    assert str(missing) in result.output
    assert "not found" in result.output.lower()


# ---------------------------------------------------------------------------
# Pre-existing-db warning.
# ---------------------------------------------------------------------------


def test_preexisting_db_warning_pure_function():
    warning = standalone._preexisting_db_warning(
        [1, 2, 3], [], user_id="alice", internal_db_path="internal.db"
    )
    assert warning is not None
    assert "3 docs" in warning
    assert "alice" in warning
    assert "datasette paper dump internal.db" in warning


def test_preexisting_db_no_warning_when_actor_has_a_visible_doc():
    assert (
        standalone._preexisting_db_warning(
            [1, 2], [2], user_id="alice", internal_db_path="internal.db"
        )
        is None
    )


def test_preexisting_db_no_warning_when_no_docs_at_all():
    assert (
        standalone._preexisting_db_warning(
            [], [], user_id="alice", internal_db_path="internal.db"
        )
        is None
    )


def _seed_doc_owned_by(internal_db_path, actor_id, name="Doc"):
    """Create one doc, owned by *actor_id*, in a fresh file-backed instance
    at *internal_db_path* — used to simulate a db from "another instance"
    whose grants are keyed to a different actor id."""

    async def _seed():
        ds = Datasette(
            internal=str(internal_db_path),
            config={"permissions": {"datasette-paper-create": True}},
        )
        await ds.invoke_startup()
        cookie = ds.sign({"a": {"id": actor_id}}, "actor")
        resp = await ds.client.post(
            "/-/paper/api/docs",
            json={"name": name},
            cookies={"ds_actor": cookie},
        )
        assert resp.status_code == 201, resp.text
        return resp.json()["id"]

    return run_sync(_seed)


def test_launch_warns_when_preexisting_db_has_no_visible_docs(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    internal_db = tmp_path / "internal.db"
    _seed_doc_owned_by(internal_db, "someone-else")

    _patch_launch_boundaries(monkeypatch, actor_id="testuser")
    runner = click.testing.CliRunner()
    result = runner.invoke(main, [str(internal_db)])

    assert result.exit_code == 0, result.output
    assert "testuser" in result.output
    assert "1 docs" in result.output
    assert "datasette paper dump" in result.output


def test_launch_no_warning_when_actor_owns_a_doc(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    internal_db = tmp_path / "internal.db"
    _seed_doc_owned_by(internal_db, "testuser")

    _patch_launch_boundaries(monkeypatch, actor_id="testuser")
    runner = click.testing.CliRunner()
    result = runner.invoke(main, [str(internal_db)])

    assert result.exit_code == 0, result.output
    assert "Warning" not in result.output


def test_launch_no_warning_and_no_check_on_fresh_db(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    internal_db = tmp_path / "internal.db"
    assert not internal_db.exists()

    # `_check_preexisting_db` is the pre-existing-db check proper (distinct
    # from `invoke_startup`, which runs its own unrelated one-time doc
    # backfills even on an empty db) — a fresh db must never reach it.
    async def _boom(ds, **kwargs):
        raise AssertionError("_check_preexisting_db should not run for a fresh db")

    monkeypatch.setattr(standalone, "_check_preexisting_db", _boom)

    _patch_launch_boundaries(monkeypatch, actor_id="testuser")
    runner = click.testing.CliRunner()
    result = runner.invoke(main, [str(internal_db)])

    assert result.exit_code == 0, result.output
    assert "Warning" not in result.output


# ---------------------------------------------------------------------------
# First-launch welcome doc (ticket 03).
# ---------------------------------------------------------------------------


def test_no_seed_on_existing_db_even_with_zero_docs(tmp_path, monkeypatch):
    """First-launch detection is "the file didn't exist", not "zero docs" —
    a pre-existing (even empty) internal db must never seed."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    internal_db = tmp_path / "internal.db"
    internal_db.touch()  # exists, but has no schema/docs yet
    assert internal_db.exists()

    async def _boom(ds, **kwargs):
        raise AssertionError(
            "_seed_welcome_doc should not run against a pre-existing db"
        )

    monkeypatch.setattr(standalone, "_seed_welcome_doc", _boom)

    captured = _patch_launch_boundaries(monkeypatch, actor_id="testuser")
    runner = click.testing.CliRunner()
    try:
        result = runner.invoke(main, [str(internal_db)])
    finally:
        _unregister_login_plugin()

    assert result.exit_code == 0, result.output
    assert "/-/paper-local-login?token=" in captured["opened_url"]


def test_first_launch_redirects_to_welcome_doc_second_to_index(tmp_path, monkeypatch):
    """CLI smoke: a fresh internal db seeds a welcome doc and the login URL
    redirects there; relaunching against the same (now-existing) internal db
    redirects to the plain doc index instead."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    internal_db = tmp_path / "internal.db"
    assert not internal_db.exists()

    runner = click.testing.CliRunner()

    # --- First launch: fresh db, seeds + redirects to the welcome doc. ---
    captured_1 = _patch_launch_boundaries(monkeypatch, actor_id="testuser")
    try:
        result_1 = runner.invoke(main, [str(internal_db)])
        assert result_1.exit_code == 0, result_1.output
        assert internal_db.exists()

        resp_1 = run_sync(
            lambda: captured_1["ds"].client.get(
                _path_and_query(captured_1["opened_url"]), follow_redirects=False
            )
        )
        assert resp_1.status_code == 302
        assert resp_1.headers["location"].startswith("/-/paper/doc/")
    finally:
        _unregister_login_plugin()

    # --- Second launch: same tmp home, db now exists -> default index. ---
    captured_2 = _patch_launch_boundaries(monkeypatch, actor_id="testuser")
    try:
        result_2 = runner.invoke(main, [str(internal_db)])
        assert result_2.exit_code == 0, result_2.output

        resp_2 = run_sync(
            lambda: captured_2["ds"].client.get(
                _path_and_query(captured_2["opened_url"]), follow_redirects=False
            )
        )
        assert resp_2.status_code == 302
        assert resp_2.headers["location"] == "/-/paper/"
    finally:
        _unregister_login_plugin()


# @feat cli-top: regression test for the console-script import order —
# importing datasette_paper.cli.standalone FIRST makes datasette's
# entry-point loader scan half-initialized plugin modules (zero hookimpls
# registered: no routes, no startup/migrations) — datasette_paper itself
# AND dependencies its import chain pulls in mid-cycle, e.g.
# datasette_user_profiles (whose lost register_actions caused
# "Unknown action: profile_access" and whose lost startup left
# "no such table: datasette_user_profiles").
# `_repair_plugin_registration` must restore full registrations. Needs a
# subprocess: inside pytest, datasette is already fully imported and the
# broken import order can't be reproduced in-process.
def test_repair_plugin_registration_console_script_import_order():
    import subprocess
    import sys
    import textwrap

    snippet = textwrap.dedent(
        """
        # Mimic the console script: this import runs datasette_paper/__init__,
        # whose import chain triggers datasette's entry-point loading mid-import.
        from datasette_paper.cli.standalone import _repair_plugin_registration

        _repair_plugin_registration()

        import datasette_paper
        import datasette_user_profiles
        from datasette.plugins import pm

        checks = [
            (datasette_paper, ("startup", "register_routes", "register_actions")),
            (datasette_user_profiles, ("startup", "register_actions")),
        ]
        for module, hooknames in checks:
            assert pm.is_registered(module), module.__name__
            for hookname in hooknames:
                impls = [
                    i
                    for i in getattr(pm.hook, hookname).get_hookimpls()
                    if i.plugin is module
                ]
                assert impls, f"{module.__name__} has no {hookname} hookimpl"
        print("ok")
        """
    )
    proc = subprocess.run(
        [sys.executable, "-c", snippet],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    assert "ok" in proc.stdout
