"""The runner's relays connect upstream as the runner, not as the session whose turn started them.

The builders start a turn's relays inside _fs_as(session), and a thread inherits its creator's filesystem uid. Linux
stamps a socket with that uid when it is made, and gVisor reads the thread's identity as each packet goes, so an
iptables owner rule (HR_TASK_EGRESS=loopback, docker/entrypoint.sh) took the runner's own call to the model for the
agent's: refused under runc, stalled once the answer began to stream under gVisor.
"""
import contextlib
import http.server
import os
import pathlib
import sys
import threading
import urllib.request

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server  # noqa: E402

UID = 20777


def _fsuid() -> int:
    for line in pathlib.Path("/proc/thread-self/status").read_text().splitlines():
        if line.startswith("Uid:"):
            return int(line.split()[4])
    raise AssertionError("no Uid line")


def test_a_relay_serves_inside_the_runners_identity(monkeypatch):
    scopes, served = [], threading.Event()

    @contextlib.contextmanager
    def fs_as(uid):
        scopes.append(uid)
        yield

    class Srv:
        def serve_forever(self):
            served.set()

    monkeypatch.setattr(server, "_fs_as", fs_as)
    server._serve_relay(Srv())
    assert served.wait(5)
    assert scopes == [0]


@pytest.mark.skipif(not sys.platform.startswith("linux") or os.geteuid() != 0, reason="filesystem uids are root's, on Linux")
def test_a_relay_started_in_a_sessions_scope_answers_as_root():
    seen = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen["fsuid"] = _fsuid()
            self.send_response(204)
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    with server._fs_as(UID):
        assert _fsuid() == UID
        server._serve_relay(srv)
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{srv.server_address[1]}/", timeout=5).close()
    finally:
        srv.shutdown()
    assert seen["fsuid"] == 0
