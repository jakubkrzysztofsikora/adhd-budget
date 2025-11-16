"""
End-to-End test for complete Enable Banking OAuth flow.
This test validates the entire authentication and MCP interaction flow:
1. Dynamic client registration
2. Authorization code grant and token exchange
3. MCP session initialization
4. Tool discovery and execution with SSE streaming
"""

import os
import uuid
from typing import Dict, Optional
from urllib.parse import parse_qs, urlparse

import aiohttp
import pytest
import requests

PROTOCOL_VERSION = "2025-06-18"


def _resolve_base_url() -> Optional[str]:
    """Determine which remote MCP deployment these E2E tests target."""

    raw = os.getenv("E2E_BASE_URL") or os.getenv("TEST_BASE_URL") or os.getenv("MCP_URL")
    return raw.rstrip("/") if raw else None


BASE_URL = _resolve_base_url()


def _server_is_available() -> bool:
    """Probe critical endpoints so we can skip instead of failing with 5xx errors."""

    if not BASE_URL:
        return False

    def _healthy(path: str) -> bool:
        try:
            resp = requests.get(f"{BASE_URL}{path}", timeout=5)
        except requests.RequestException:
            return False
        return resp.status_code < 500

    # Require both health and OAuth metadata to respond. Caddy often keeps
    # /health up even when the upstream application is down, so also verify the
    # metadata endpoint that the first test hits to avoid cascading 502s.
    return _healthy("/health") and _healthy("/.well-known/oauth-authorization-server")


pytestmark = pytest.mark.skipif(
    not _server_is_available(),
    reason=(
        "Remote MCP server is not reachable – set TEST_BASE_URL/E2E_BASE_URL "
        "and ensure the deployment is running before executing the E2E suite."
    ),
)


class TestEnableBankingOAuthComplete:
    """Complete E2E test for Enable Banking OAuth + MCP flow"""

    def _base_url(self) -> str:
        assert BASE_URL, "Base URL resolution should be guaranteed by pytestmark"
        return BASE_URL

    def _mcp_url(self) -> str:
        base = self._base_url().rstrip("/")
        return f"{base}/mcp"

    @pytest.fixture(scope="module")
    def session_state(self) -> Dict[str, Optional[str]]:
        """Fixture to maintain shared state across the ordered E2E steps."""

        return {
            "client_id": None,
            "client_secret": None,
            "redirect_uri": os.getenv("MCP_REDIRECT_URI", "http://localhost:6274/callback"),
            "state": str(uuid.uuid4()),
            "authorization_code": os.getenv("MCP_TEST_AUTH_CODE")
            or os.getenv("MCP_TEST_AUTHORIZATION_CODE"),
            "access_token": os.getenv("MCP_TEST_ACCESS_TOKEN"),
            "refresh_token": os.getenv("MCP_TEST_REFRESH_TOKEN"),
            "session_id": None,
        }

    def _build_mcp_headers(self, session_state: Dict[str, Optional[str]]) -> Dict[str, str]:
        if not session_state["session_id"]:
            pytest.skip("MCP session not initialised – run test_05_mcp_connection first.")
        if not session_state["access_token"]:
            pytest.skip(
                "Access token missing – complete the token exchange or export MCP_TEST_ACCESS_TOKEN."
            )
        return {
            "Authorization": f"Bearer {session_state['access_token']}",
            "Content-Type": "application/json",
            "Mcp-Session-Id": session_state["session_id"],
            "MCP-Protocol-Version": PROTOCOL_VERSION,
        }

    def _require_access_token(self, session_state: Dict[str, Optional[str]]) -> str:
        token = session_state.get("access_token")
        if not token:
            pytest.skip(
                "Access token unavailable – export MCP_TEST_ACCESS_TOKEN or complete the token exchange."
            )
        return token

    def test_01_oauth_discovery(self):
        """Test that OAuth discovery endpoint is available"""
        base_url = self._base_url()
        response = requests.get(f"{base_url}/.well-known/oauth-authorization-server", timeout=5)
        assert response.status_code == 200
        metadata = response.json()

        assert metadata["authorization_endpoint"] == f"{base_url}/oauth/authorize"
        assert metadata["token_endpoint"] == f"{base_url}/oauth/token"
        assert "authorization_code" in metadata.get("grant_types_supported", [])
        assert PROTOCOL_VERSION.startswith("2025")

    def test_02_client_registration(self, session_state):
        """Test dynamic client registration"""
        registration_data = {
            "application_type": "web",
            "redirect_uris": [session_state["redirect_uri"]],
            "client_name": f"MCP Inspector {uuid.uuid4()}",
            "grant_types": ["authorization_code", "refresh_token"],
        }

        base_url = self._base_url()
        response = requests.post(
            f"{base_url}/oauth/register",
            json=registration_data,
            headers={"Content-Type": "application/json"},
            timeout=5,
        )

        assert response.status_code == 201
        client_info = response.json()

        session_state["client_id"] = client_info["client_id"]
        session_state["client_secret"] = client_info.get("client_secret")

    def test_03_authorization_flow(self, session_state):
        """Test the authorization flow to get an authorization code"""
        params = {
            "response_type": "code",
            "client_id": session_state["client_id"],
            "redirect_uri": session_state["redirect_uri"],
            "state": session_state["state"],
            "scope": "accounts transactions summary",
        }

        base_url = self._base_url()
        response = requests.get(
            f"{base_url}/oauth/authorize",
            params=params,
            allow_redirects=False,
            timeout=5,
        )

        assert response.status_code in (302, 303)
        location = response.headers.get("Location", "")
        assert location, "Missing redirect location"
        parsed = urlparse(location)
        query = parse_qs(parsed.query)
        if query:
            assert query.get("state", [None])[0] == session_state["state"]
        code = query.get("code", [None])[0]

        if code:
            session_state["authorization_code"] = code
        elif "enablebanking" in location.lower():
            if not session_state["authorization_code"]:
                pytest.skip(
                    "Enable Banking consent must complete interactively – set MCP_TEST_AUTH_CODE "
                    "once you have a callback code."
                )
        else:
            pytest.fail(f"Unexpected redirect target: {location}")

    def test_04_token_exchange(self, session_state):
        """Test exchanging authorization code for access token"""
        if not session_state["authorization_code"]:
            pytest.skip(
                "Authorization code unavailable – run the consent flow or export MCP_TEST_AUTH_CODE."
            )

        token_data = {
            "grant_type": "authorization_code",
            "code": session_state["authorization_code"],
            "redirect_uri": session_state["redirect_uri"],
            "client_id": session_state["client_id"],
            "client_secret": session_state["client_secret"],
        }

        base_url = self._base_url()
        response = requests.post(
            f"{base_url}/oauth/token",
            json=token_data,
            headers={"Content-Type": "application/json"},
            timeout=5,
        )

        assert response.status_code == 200, response.text
        token_response = response.json()
        session_state["access_token"] = token_response.get("access_token")
        session_state["refresh_token"] = token_response.get("refresh_token")

    @pytest.mark.asyncio
    async def test_05_mcp_connection(self, session_state):
        """Test connecting to MCP server with access token"""
        bearer = self._require_access_token(session_state)
        headers = {
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
        }

        init_request = {
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "test-client", "version": "1.0.0"},
            },
            "id": 1,
        }

        mcp_url = self._mcp_url()

        async with aiohttp.ClientSession() as session:
            async with session.post(mcp_url, json=init_request, headers=headers) as response:
                assert response.status == 200
                session_state["session_id"] = response.headers.get("Mcp-Session-Id")
                payload = await response.json()
                assert payload.get("result", {}).get("protocolVersion") == PROTOCOL_VERSION

    @pytest.mark.asyncio
    async def test_06_mcp_tools_list(self, session_state):
        """Test listing available MCP tools"""
        headers = self._build_mcp_headers(session_state)

        list_request = {"jsonrpc": "2.0", "method": "tools/list", "params": {}, "id": 2}

        mcp_url = self._mcp_url()

        async with aiohttp.ClientSession() as session:
            async with session.post(mcp_url, json=list_request, headers=headers) as response:
                assert response.status == 200
                result = await response.json()
                tools = result.get("result", {}).get("tools", [])
                assert tools
                assert any(tool["name"] == "summary.today" for tool in tools)

    @pytest.mark.asyncio
    async def test_07_mcp_tool_execution(self, session_state):
        """Test executing an MCP tool"""
        headers = self._build_mcp_headers(session_state)

        tool_request = {
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": "summary.today", "arguments": {}},
            "id": 3,
        }

        mcp_url = self._mcp_url()

        async with aiohttp.ClientSession() as session:
            async with session.post(mcp_url, json=tool_request, headers=headers) as response:
                assert response.status == 200
                result = await response.json()
                assert "result" in result or "error" in result

    @pytest.mark.asyncio
    async def test_08_mcp_sse_streaming(self, session_state):
        """Test SSE streaming functionality"""
        headers = self._build_mcp_headers(session_state)
        headers = {**headers, "Accept": "text/event-stream"}

        mcp_url = self._mcp_url()

        async with aiohttp.ClientSession() as session:
            async with session.get(mcp_url, headers=headers, timeout=aiohttp.ClientTimeout(total=5)) as response:
                assert response.status == 200
                assert "text/event-stream" in response.headers.get("Content-Type", "")
                line = await response.content.readline()
                assert line.decode("utf-8").startswith("event:"), "Expected SSE event line"

    def test_09_complete_flow_integration(self, session_state):
        """Test the complete flow from start to finish"""
        base_url = self._base_url()
        health_response = requests.get(f"{base_url}/health", timeout=5)
        assert health_response.status_code == 200

        protected_resource = requests.get(
            f"{base_url}/.well-known/oauth-protected-resource",
            timeout=5,
        )
        assert protected_resource.status_code == 200
        metadata = protected_resource.json().get("protectedResourceMetadata", {})
        assert metadata.get("resource") == f"{base_url}/mcp"

        # Verify the session can still call tools
        headers = self._build_mcp_headers(session_state)
        mcp_url = self._mcp_url()

        response = requests.post(
            mcp_url,
            json={
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {"name": "projection.month", "arguments": {}},
                "id": "final-check",
            },
            headers=headers,
            timeout=5,
        )
        assert response.status_code == 200
        payload = response.json()
        assert "result" in payload or "error" in payload


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
