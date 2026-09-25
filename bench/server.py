"""Spawn a datasette + datasette-paper server for the bench and sample its RSS.

Mirrors ``just dev`` (permissions + max_post_body_bytes) but grants
``paper-view`` / ``paper-edit`` globally the way the e2e config does, so
every simulated actor can edit every doc without acl share grants. The
internal DB is a fresh file per run so the step log doesn't inflate RSS
the way an in-memory internal DB would.

``--repo-path`` runs the server out of another checkout's uv project
(``uv run --project``), which is how you A/B two git worktrees.
"""

from __future__ import annotations

import atexit
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx2 as httpx
import psutil

SECRET = "bench-secret"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, repo_path: Path, workdir: Path, port: int | None = None):
        self.repo_path = repo_path.resolve()
        self.workdir = workdir
        self.port = port or free_port()
        self.proc: subprocess.Popen | None = None
        self.log_path = workdir / "server.log"
        self.internal_db = workdir / "internal.db"
        self._ps: psutil.Process | None = None
        self._target_ps: psutil.Process | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self, timeout: float = 120.0) -> None:
        self.workdir.mkdir(parents=True, exist_ok=True)
        if self.internal_db.exists():
            self.internal_db.unlink()
        cmd = [
            "uv",
            "run",
            "--prerelease=allow",
            "--project",
            str(self.repo_path),
            "datasette",
            "--internal",
            str(self.internal_db),
            "-s",
            "permissions.datasette-paper-create",
            "true",
            "-s",
            "permissions.paper-view",
            "true",
            "-s",
            "permissions.paper-edit",
            "true",
            "-s",
            "settings.max_post_body_bytes",
            "13631488",
            "-p",
            str(self.port),
            "-h",
            "127.0.0.1",
        ]
        env = dict(os.environ, DATASETTE_SECRET=SECRET)
        log = open(self.log_path, "wb")
        # Own process group so teardown can signal uv + datasette together;
        # atexit is the backstop for exception / Ctrl-C paths.
        self.proc = subprocess.Popen(
            cmd,
            cwd=self.repo_path,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        atexit.register(self.stop)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(
                    f"server exited early ({self.proc.returncode}); see {self.log_path}"
                )
            try:
                r = httpx.get(self.url + "/-/paper/api/docs", timeout=2.0)
                if r.status_code < 500:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.5)
        else:
            self.stop()
            raise RuntimeError(
                f"server did not come up in {timeout}s; see {self.log_path}"
            )
        self._ps = psutil.Process(self.proc.pid)
        print(
            f"[bench] server up at {self.url} (pid {self.proc.pid}), log {self.log_path}"
        )

    def _target(self) -> psutil.Process | None:
        """The datasette python process: heaviest of the uv wrapper's tree.

        Cached once found so ``cpu_percent`` has a previous sample to diff
        against (a fresh ``Process`` object always reports 0.0).
        """
        if self._ps is None:
            return None
        if self._target_ps is not None and self._target_ps.is_running():
            return self._target_ps
        try:
            procs = [self._ps] + self._ps.children(recursive=True)
            self._target_ps = max(procs, key=lambda p: p.memory_info().rss)
            return self._target_ps
        except psutil.Error:
            return None

    def sample(self) -> tuple[float, float] | None:
        """(rss_bytes, cpu_percent since last call) of the server process."""
        p = self._target()
        if p is None:
            return None
        try:
            return float(p.memory_info().rss), p.cpu_percent(interval=None)
        except psutil.Error:
            return None

    def stop(self) -> None:
        """Tear the whole server tree down, hard if needed.

        uvicorn's SIGTERM handling waits for open connections (SSE streams
        never end) with no timeout, and ``uv run`` exits as soon as it is
        signalled — so a plain terminate + wait on the wrapper left
        datasette orphaned and listening. Signal the process group, wait a
        few seconds for *every* process in the tree, then SIGKILL survivors.
        """
        proc, self.proc = self.proc, None
        if proc is None:
            return
        try:
            tree = [psutil.Process(proc.pid)]
            tree += tree[0].children(recursive=True)
        except psutil.Error:
            tree = []
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        _, alive = psutil.wait_procs(tree, timeout=5)
        for p in alive:
            try:
                p.kill()
            except psutil.Error:
                pass
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass

    def log_issues(self) -> dict:
        """Count tracebacks / error lines in the server log for the report."""
        if not self.log_path.exists():
            return {}
        text = self.log_path.read_text(errors="replace")
        tracebacks = text.count("Traceback (most recent call last)")
        errors = sum(
            1
            for line in text.splitlines()
            if " ERROR" in line
            or "error" in line.lower()
            and "traceback" not in line.lower()
        )
        return {"tracebacks": tracebacks, "error_lines": errors, "bytes": len(text)}


def sign_actor_cookie(actor_id: str, secret: str = SECRET) -> str:
    """A ``ds_actor`` cookie value datasette accepts (same as ``Datasette.sign``)."""
    from itsdangerous import URLSafeSerializer

    return URLSafeSerializer(secret, "actor").dumps({"a": {"id": actor_id}})


if __name__ == "__main__":  # quick manual check: python -m bench.server <repo>
    s = Server(Path(sys.argv[1]), Path("/tmp/bench-server-check"))
    s.start()
    print(s.sample())
    s.stop()
