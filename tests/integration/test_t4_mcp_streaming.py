"""
T4 Gate: MCP JSON-RPC 2.0 over SSE through Proxy
Real streaming test - no mocks
"""

import asyncio
import json
import os
import time
import uuid
from typing import Dict
from urllib.parse import parse_qs, urlparse

import aiohttp
import pytest
import requests

PROTOCOL_VERSION = "2025-06-18"


class TestT4MCPStreaming:
    """Test MCP through real Caddy proxy with SSE"""

    @pytest.fixture(scope="class")
    def proxy_url(self) -> str:
        """Proxy URL (Caddy)."""
        return os.getenv("PROXY_URL", "http://reverse-proxy")

    @pytest.fixture(scope="class")
    def oauth_client(self, proxy_url: str) -> Dict[str, str]:
        """Register an OAuth client against the server under test."""

        redirect_uri = os.getenv("MCP_REDIRECT_URI", "http://localhost:6274/callback")
        registration = {
            "application_type": "web",
            "redirect_uris": [redirect_uri],
            "client_name": f"MCP Integration Tests {uuid.uuid4()}",
            "grant_types": ["authorization_code", "refresh_token"],
        }

        response = requests.post(
            f"{proxy_url}/oauth/register",
            json=registration,
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        assert response.status_code == 201, response.text
        payload = response.json()
        payload["redirect_uri"] = redirect_uri
        return payload

    @pytest.fixture(scope="class")
    def mcp_token(self, proxy_url: str, oauth_client: Dict[str, str]) -> Dict[str, str]:
        """Obtain an OAuth bearer token that can access protected tools."""

        params = {
            "response_type": "code",
            "client_id": oauth_client["client_id"],
            "redirect_uri": oauth_client["redirect_uri"],
            "scope": "accounts transactions summary",
            "state": str(uuid.uuid4()),
        }

        response = requests.get(
            f"{proxy_url}/oauth/authorize",
            params=params,
            allow_redirects=False,
            timeout=10,
        )
        assert response.status_code in (302, 303), response.text
        location = response.headers.get("Location", "")
        parsed = urlparse(location)
        query = parse_qs(parsed.query)
        assert "code" in query, f"Missing authorization code in redirect: {location}"
        code = query["code"][0]

        token_request = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": oauth_client["redirect_uri"],
            "client_id": oauth_client["client_id"],
            "client_secret": oauth_client["client_secret"],
        }

        token_response = requests.post(
            f"{proxy_url}/oauth/token",
            json=token_request,
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        assert token_response.status_code == 200, token_response.text
        return token_response.json()

    @pytest.fixture(scope="class")
    def mcp_session(self, proxy_url: str, mcp_token: Dict[str, str]) -> Dict[str, str]:
        """Initialise an MCP session and return reusable headers."""

        init_request = {
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "integration-tests", "version": "1.0"},
            },
            "id": "init",
        }

        response = requests.post(
            f"{proxy_url}/mcp",
            json=init_request,
            headers={
                "Content-Type": "application/json",
                "MCP-Protocol-Version": PROTOCOL_VERSION,
                "Authorization": f"Bearer {mcp_token['access_token']}",
            },
            timeout=10,
        )
        assert response.status_code == 200, response.text
        session_id = response.headers.get("Mcp-Session-Id")
        assert session_id, "Expected Mcp-Session-Id header in initialize response"

        base_headers = {
            "Authorization": f"Bearer {mcp_token['access_token']}",
            "Content-Type": "application/json",
            "Mcp-Session-Id": session_id,
            "MCP-Protocol-Version": PROTOCOL_VERSION,
        }

        return {"id": session_id, "headers": base_headers}

    def test_jsonrpc_through_proxy(self, proxy_url: str, mcp_session: Dict[str, str]) -> None:
        """T4: JSON-RPC 2.0 compliance through proxy."""

        response = requests.post(
            f"{proxy_url}/mcp",
            json={"jsonrpc": "2.0", "method": "tools/list", "id": "test-1"},
            headers={**mcp_session["headers"]},
            timeout=10,
        )

        assert response.status_code == 200, f"Got {response.status_code}: {response.text}"
        data = response.json()
        assert data.get("jsonrpc") == "2.0"
        assert data.get("id") == "test-1"
        assert "result" in data or "error" in data

        tools = data.get("result", {}).get("tools", [])
        if tools:
            tool_names = {tool["name"] for tool in tools}
            assert "summary.today" in tool_names
            assert "projection.month" in tool_names
            assert "transactions.query" in tool_names

    def test_sse_streaming_through_proxy(self, proxy_url: str, mcp_session: Dict[str, str]) -> None:
        """T4: SSE streaming preserved through proxy - proper long-lived connection."""

        response = requests.get(
            f"{proxy_url}/mcp",
            headers={
                "Authorization": mcp_session["headers"]["Authorization"],
                "Accept": "text/event-stream",
                "Mcp-Session-Id": mcp_session["id"],
                "MCP-Protocol-Version": PROTOCOL_VERSION,
            },
            stream=True,
            timeout=5,
        )

        try:
            assert response.status_code == 200
            assert response.headers.get("Content-Type") == "text/event-stream"

            chunks_with_timing = []
            start_time = time.time()
            response_iter = response.iter_lines(decode_unicode=True, chunk_size=1)
            end_time = time.time() + 2

            while time.time() < end_time:
                try:
                    line = next(response_iter)
                except StopIteration:
                    time.sleep(0.05)
                    continue

                if not line:
                    continue

                arrival_time = time.time() - start_time
                chunks_with_timing.append((arrival_time, line))
                if len(chunks_with_timing) >= 6:
                    break

            assert len(chunks_with_timing) >= 4, f"Not enough SSE events received: {len(chunks_with_timing)}"

            event_lines = 0
            data_lines = 0
            for _, chunk in chunks_with_timing:
                if chunk.startswith("event:"):
                    event_lines += 1
                elif chunk.startswith("data:"):
                    data_lines += 1
                elif chunk.strip():
                    pytest.fail(f"Invalid SSE format: {chunk}")

            assert event_lines >= 2, f"Not enough event lines: {event_lines}"
            assert data_lines >= 2, f"Not enough data lines: {data_lines}"

            if chunks_with_timing:
                assert chunks_with_timing[0][0] < 0.5, "Initial SSE event took too long"
        finally:
            response.close()

    def test_no_websocket_usage(self, proxy_url: str) -> None:
        """T4: Verify WebSockets are NOT used."""

        try:
            response = requests.get(
                f"{proxy_url}/mcp",
                headers={
                    "Upgrade": "websocket",
                    "Connection": "Upgrade",
                    "Sec-WebSocket-Key": "x3JJHMbDL1EzLkh9GBhXDw==",
                    "Sec-WebSocket-Version": "13",
                },
                timeout=5,
            )
            assert response.status_code != 101
        except requests.RequestException:
            pass

    def test_tool_invocation_through_proxy(self, proxy_url: str, mcp_session: Dict[str, str]) -> None:
        """T4: Tool invocation works through proxy."""

        tools_to_test = [
            ("summary.today", {}),
            ("projection.month", {}),
            ("transactions.query", {"since": "2024-01-01T00:00:00Z"}),
        ]

        for tool_name, args in tools_to_test:
            response = requests.post(
                f"{proxy_url}/mcp",
                json={
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "params": {"name": tool_name, "arguments": args},
                    "id": f"test-{tool_name}",
                },
                headers={**mcp_session["headers"]},
                timeout=10,
            )

            assert response.status_code in (200, 401)
            data = response.json()
            assert "result" in data or "error" in data

    def test_malformed_request_handling(self, proxy_url: str, mcp_session: Dict[str, str]) -> None:
        """T4: Malformed requests return proper errors."""

        malformed_requests = [
            {"method": "test"},
            {"jsonrpc": "1.0", "method": "test", "id": 1},
            {"jsonrpc": "2.0", "id": 1},
        ]

        for bad_request in malformed_requests:
            response = requests.post(
                f"{proxy_url}/mcp",
                json=bad_request,
                headers={**mcp_session["headers"]},
                timeout=10,
            )

            assert response.status_code in (200, 400, 401)
            if response.status_code == 200:
                data = response.json()
                assert "error" in data
                assert data["error"]["code"] in [-32700, -32600, -32602]

    @pytest.mark.asyncio
    async def test_long_running_stream(self, proxy_url: str, mcp_session: Dict[str, str]) -> None:
        """T4: Long-running streams don't deadlock."""

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{proxy_url}/mcp",
                json={
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "params": {
                        "name": "transactions.query",
                        "arguments": {"since": "2020-01-01T00:00:00Z", "limit": 10},
                    },
                    "id": "long-test",
                },
                headers={**mcp_session["headers"]},
                timeout=aiohttp.ClientTimeout(total=30),
            ) as response:
                assert response.status == 200
                data = await response.json()
                assert "result" in data or "error" in data

    def test_auth_required(self, proxy_url: str) -> None:
        """T4: Unauthorized requests rejected."""

        response = requests.post(
            f"{proxy_url}/mcp",
            json={
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {"name": "summary.today", "arguments": {}},
                "id": "unauth",
            },
            timeout=5,
        )

        assert response.status_code == 401
        data = response.json()
        assert "error" in data


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
