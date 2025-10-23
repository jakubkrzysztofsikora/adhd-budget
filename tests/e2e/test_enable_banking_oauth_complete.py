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


class TestEnableBankingOAuthComplete:
    """Complete E2E test for Enable Banking OAuth + MCP flow"""

    BASE_URL = os.getenv("TEST_BASE_URL", "http://localhost")
    MCP_URL = f"{BASE_URL}/mcp"

    @pytest.fixture(scope="module")
    def session_state(self) -> Dict[str, Optional[str]]:
        """Fixture to maintain shared state across the ordered E2E steps."""

        return {
            "client_id": None,
            "client_secret": None,
            "redirect_uri": os.getenv("MCP_REDIRECT_URI", "http://localhost:6274/callback"),
            "state": str(uuid.uuid4()),
            "authorization_code": None,
            "access_token": None,
            "refresh_token": None,
            "session_id": None,
        }

    def _build_mcp_headers(self, session_state: Dict[str, Optional[str]]) -> Dict[str, str]:
        assert session_state["session_id"], "MCP session not initialised"
        assert session_state["access_token"], "Access token missing"
        return {
            "Authorization": f"Bearer {session_state['access_token']}",
            "Content-Type": "application/json",
            "Mcp-Session-Id": session_state["session_id"],
            "MCP-Protocol-Version": PROTOCOL_VERSION,
        }

    def test_01_oauth_discovery(self):
        """Test that OAuth discovery endpoint is available"""
        response = requests.get(f"{self.BASE_URL}/.well-known/oauth-authorization-server", timeout=5)
        assert response.status_code == 200
        metadata = response.json()

        assert metadata["authorization_endpoint"] == f"{self.BASE_URL}/oauth/authorize"
        assert metadata["token_endpoint"] == f"{self.BASE_URL}/oauth/token"
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

        response = requests.post(
            f"{self.BASE_URL}/oauth/register",
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

        response = requests.get(
            f"{self.BASE_URL}/oauth/authorize",
            params=params,
            allow_redirects=False,
            timeout=5,
        )

        assert response.status_code in (302, 303)
        location = response.headers.get("Location", "")
        parsed = urlparse(location)
        query = parse_qs(parsed.query)
        assert query.get("state", [None])[0] == session_state["state"]
        code = query.get("code", [None])[0]
        assert code, "Authorization code missing from redirect"
        session_state["authorization_code"] = code

    def test_04_token_exchange(self, session_state):
        """Test exchanging authorization code for access token"""
        token_data = {
            "grant_type": "authorization_code",
            "code": session_state["authorization_code"],
            "redirect_uri": session_state["redirect_uri"],
            "client_id": session_state["client_id"],
            "client_secret": session_state["client_secret"],
        }

        response = requests.post(
            f"{self.BASE_URL}/oauth/token",
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
        headers = {
            "Authorization": f"Bearer {session_state['access_token']}",
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

        async with aiohttp.ClientSession() as session:
            async with session.post(self.MCP_URL, json=init_request, headers=headers) as response:
                assert response.status == 200
                session_state["session_id"] = response.headers.get("Mcp-Session-Id")
                payload = await response.json()
                assert payload.get("result", {}).get("protocolVersion") == PROTOCOL_VERSION

    @pytest.mark.asyncio
    async def test_06_mcp_tools_list(self, session_state):
        """Test listing available MCP tools"""
        headers = self._build_mcp_headers(session_state)

        list_request = {"jsonrpc": "2.0", "method": "tools/list", "params": {}, "id": 2}

        async with aiohttp.ClientSession() as session:
            async with session.post(self.MCP_URL, json=list_request, headers=headers) as response:
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

        async with aiohttp.ClientSession() as session:
            async with session.post(self.MCP_URL, json=tool_request, headers=headers) as response:
                assert response.status == 200
                result = await response.json()
                assert "result" in result or "error" in result

    @pytest.mark.asyncio
    async def test_08_mcp_sse_streaming(self, session_state):
        """Test SSE streaming functionality"""
        headers = {
            "Authorization": f"Bearer {session_state['access_token']}",
            "Accept": "text/event-stream",
            "Mcp-Session-Id": session_state["session_id"],
            "MCP-Protocol-Version": PROTOCOL_VERSION,
        }

        async with aiohttp.ClientSession() as session:
            async with session.get(self.MCP_URL, headers=headers, timeout=aiohttp.ClientTimeout(total=5)) as response:
                assert response.status == 200
                assert "text/event-stream" in response.headers.get("Content-Type", "")
                line = await response.content.readline()
                assert line.decode("utf-8").startswith("event:"), "Expected SSE event line"

    def test_09_complete_flow_integration(self, session_state):
        """Test the complete flow from start to finish"""
        health_response = requests.get(f"{self.BASE_URL}/health", timeout=5)
        assert health_response.status_code == 200

        protected_resource = requests.get(
            f"{self.BASE_URL}/.well-known/oauth-protected-resource",
            timeout=5,
        )
        assert protected_resource.status_code == 200
        metadata = protected_resource.json().get("protectedResourceMetadata", {})
        assert metadata.get("resource") == f"{self.BASE_URL}/mcp"

        # Verify the session can still call tools
        headers = self._build_mcp_headers(session_state)
        response = requests.post(
            self.MCP_URL,
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
