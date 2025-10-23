"""Shared pytest configuration for the project test suite."""
from __future__ import annotations

import asyncio
import os
import sys
import threading
from pathlib import Path
from typing import Generator

import pytest
from aiohttp import web


# Ensure the repository root (which contains the ``src`` package) is importable.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(scope="session", autouse=True)
def launch_mcp_server() -> Generator[None, None, None]:
    """Spin up the MCP server for tests that rely on HTTP endpoints.

    The heavier integration suites normally exercise the stack through Docker
    Compose.  When those services are unavailable (for example in constrained
    CI environments) we still want deterministic coverage, so this fixture
    boots ``src.mcp_remote_server`` on ``127.0.0.1`` and wires the relevant
    environment variables to point at it.
    """

    if os.getenv("TEST_BASE_URL") or os.getenv("PROXY_URL"):
        # An explicit base URL was provided (likely by docker-compose). Leave
        # the environment untouched and don't start an in-process server.
        yield
        return

    from src.mcp_remote_server import create_app

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(None)

    ready = threading.Event()

    def _run() -> None:
        asyncio.set_event_loop(loop)
        app = create_app()
        runner = web.AppRunner(app)
        loop.run_until_complete(runner.setup())
        site = web.TCPSite(runner, host="127.0.0.1", port=0)
        loop.run_until_complete(site.start())
        sockets = site._server.sockets  # type: ignore[attr-defined]
        assert sockets, "aiohttp site did not expose any sockets"
        port = sockets[0].getsockname()[1]
        base_url = f"http://127.0.0.1:{port}"
        os.environ["TEST_BASE_URL"] = base_url
        os.environ["PROXY_URL"] = base_url
        os.environ["API_URL"] = base_url
        os.environ["MCP_URL"] = base_url
        os.environ["MCP_HOST"] = "127.0.0.1"
        os.environ["MCP_PORT"] = str(port)
        ready.set()
        try:
            loop.run_forever()
        finally:
            loop.run_until_complete(runner.cleanup())
            loop.close()

    thread = threading.Thread(target=_run, name="mcp-test-server", daemon=True)
    thread.start()
    if not ready.wait(timeout=10):
        raise RuntimeError("Timed out starting MCP test server")

    try:
        yield
    finally:
        if loop.is_running():
            loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
