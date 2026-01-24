"""Shared pytest configuration for the project test suite."""
from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
from pathlib import Path
from typing import Generator

import pytest


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
    boots the FastAPI MCP server on ``127.0.0.1`` and wires the relevant
    environment variables to point at it.
    """

    if os.getenv("TEST_BASE_URL") or os.getenv("PROXY_URL"):
        # An explicit base URL was provided (likely by docker-compose). Leave
        # the environment untouched and don't start an in-process server.
        yield
        return

    # Use the new FastAPI server
    import uvicorn
    from src.mcp_fastapi_server import create_app

    # Find an available port
    import socket
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()

    base_url = f"http://127.0.0.1:{port}"
    os.environ["TEST_BASE_URL"] = base_url
    os.environ["PROXY_URL"] = base_url
    os.environ["API_URL"] = base_url
    os.environ["MCP_URL"] = base_url
    os.environ["MCP_HOST"] = "127.0.0.1"
    os.environ["MCP_PORT"] = str(port)

    app = create_app()
    config = uvicorn.Config(
        app=app,
        host="127.0.0.1",
        port=port,
        log_level="error",
        access_log=False,
    )
    server = uvicorn.Server(config)

    def run_server():
        asyncio.run(server.serve())

    thread = threading.Thread(target=run_server, name="mcp-test-server", daemon=True)
    thread.start()

    # Wait for server to be ready
    import requests
    server_ready = False
    for _ in range(50):  # 5 seconds total
        try:
            requests.get(f"{base_url}/health", timeout=1)
            server_ready = True
            break
        except (requests.ConnectionError, requests.Timeout):
            time.sleep(0.1)
    
    if not server_ready:
        server.should_exit = True
        thread.join(timeout=2)
        raise RuntimeError(f"MCP test server failed to start on {base_url}")

    try:
        yield
    finally:
        server.should_exit = True
        thread.join(timeout=5)
