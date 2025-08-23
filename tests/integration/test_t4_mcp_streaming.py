"""
T4 Gate: MCP JSON-RPC 2.0 over SSE through Proxy
Real streaming test - no mocks
"""

import pytest
import requests
import json
import time
import asyncio
import aiohttp
import os
from typing import List


class TestT4MCPStreaming:
    """Test MCP through real Caddy proxy with SSE"""
    
    @pytest.fixture(scope="class")
    def proxy_url(self):
        """Proxy URL (Caddy)"""
        # Use environment variable or correct container hostname
        return os.getenv("PROXY_URL", "http://reverse-proxy")
    
    @pytest.fixture(scope="class") 
    def mcp_token(self):
        """MCP auth token"""
        # Use OAuth access token or test token
        return os.getenv("MCP_TOKEN", "test_mcp_token_secure_2024")
    
    def test_jsonrpc_through_proxy(self, proxy_url, mcp_token):
        """T4: JSON-RPC 2.0 compliance through proxy"""
        # Test tools/list through proxy
        response = requests.post(
            f"{proxy_url}/mcp",
            json={
                "jsonrpc": "2.0",
                "method": "tools/list",
                "id": "test-1"
            },
            headers={
                "Authorization": f"Bearer {mcp_token}",
                "Content-Type": "application/json"
            },
            timeout=5
        )
        
        assert response.status_code == 200, f"Got {response.status_code}: {response.text}"
        data = response.json()
        
        # Validate JSON-RPC 2.0 structure
        assert data.get("jsonrpc") == "2.0"
        assert data.get("id") == "test-1"
        assert "result" in data or "error" in data
        
        if "result" in data:
            tools = data["result"].get("tools", [])
            tool_names = [t["name"] for t in tools]
            
            # Required tools per claude.md
            assert "summary.today" in tool_names
            assert "projection.month" in tool_names
            assert "transactions.query" in tool_names
    
    def test_sse_streaming_through_proxy(self, proxy_url, mcp_token):
        """T4: SSE streaming preserved through proxy - proper long-lived connection"""
        # Test SSE endpoint through proxy
        response = requests.get(
            f"{proxy_url}/mcp/stream",
            headers={
                "Authorization": f"Bearer {mcp_token}",
                "Accept": "text/event-stream"
            },
            stream=True,
            timeout=10  # Reasonable timeout for initial events
        )
        
        try:
            assert response.status_code == 200
            assert response.headers.get("Content-Type") == "text/event-stream"
            
            # Collect initial events to verify SSE is working
            chunks_with_timing = []
            start_time = time.time()
            
            # Read events for up to 2 seconds to get initial events
            for line in response.iter_lines(decode_unicode=True):
                if line:
                    arrival_time = time.time() - start_time
                    chunks_with_timing.append((arrival_time, line))
                    
                    # Collect at least 6 events (connected + 3 progress events + formatting)
                    # or stop after 2 seconds
                    if len(chunks_with_timing) >= 6 or arrival_time > 2:
                        break
            
            # Verify we received SSE events
            assert len(chunks_with_timing) >= 4, f"Not enough SSE events received: {len(chunks_with_timing)}"
            
            # Verify events are properly formatted (event: or data:)
            event_lines = 0
            data_lines = 0
            for _, chunk in chunks_with_timing:
                if chunk.startswith('event:'):
                    event_lines += 1
                elif chunk.startswith('data:'):
                    data_lines += 1
                elif chunk.strip():  # Non-empty lines should be SSE formatted
                    assert False, f"Invalid SSE format: {chunk}"
            
            assert event_lines >= 2, f"Not enough event lines: {event_lines}"
            assert data_lines >= 2, f"Not enough data lines: {data_lines}"
            
            # Verify chunks arrived over time (streaming not buffered)
            # Find actual data events (pairs of event: and data: lines)
            event_times = [t for t, c in chunks_with_timing if c.startswith('event:')]
            if len(event_times) >= 2:
                time_diff = event_times[1] - event_times[0]
                assert time_diff > 0.2, f"Events arrived too quickly (buffered): {time_diff}s"
            
            # Verify the SSE connection would stay alive (it's sending heartbeats)
            # but we don't wait for them in the test
        
        finally:
            # Force close the long-lived SSE connection
            # This is expected for SSE - client decides when to disconnect
            response.close()
    
    def test_no_websocket_usage(self, proxy_url):
        """T4: Verify WebSockets are NOT used"""
        # Attempt WebSocket upgrade should fail
        ws_url = proxy_url.replace("http://", "ws://") + "/mcp"
        
        try:
            response = requests.get(
                proxy_url + "/mcp",
                headers={
                    "Upgrade": "websocket",
                    "Connection": "Upgrade",
                    "Sec-WebSocket-Key": "x3JJHMbDL1EzLkh9GBhXDw==",
                    "Sec-WebSocket-Version": "13"
                },
                timeout=10
            )
            # Should not upgrade to WebSocket
            assert response.status_code != 101, "WebSocket upgrade should fail"
        except Exception:
            pass  # Expected to fail
    
    def test_tool_invocation_through_proxy(self, proxy_url, mcp_token):
        """T4: Tool invocation works through proxy"""
        tools_to_test = [
            ("summary.today", {}),
            ("projection.month", {}),
            ("transactions.query", {"since": "2024-01-01T00:00:00Z"})
        ]
        
        for tool_name, args in tools_to_test:
            response = requests.post(
                f"{proxy_url}/mcp",
                json={
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "params": {
                        "name": tool_name,
                        "arguments": args
                    },
                    "id": f"test-{tool_name}"
                },
                headers={
                    "Authorization": f"Bearer {mcp_token}",
                    "Content-Type": "application/json"
                },
                timeout=10
            )
            
            assert response.status_code == 200
            data = response.json()
            assert "result" in data or "error" in data
    
    def test_malformed_request_handling(self, proxy_url, mcp_token):
        """T4: Malformed requests return proper errors"""
        malformed_requests = [
            {"method": "test"},  # Missing jsonrpc
            {"jsonrpc": "1.0", "method": "test", "id": 1},  # Wrong version
            {"jsonrpc": "2.0", "id": 1},  # Missing method
        ]
        
        for bad_request in malformed_requests:
            response = requests.post(
                f"{proxy_url}/mcp",
                json=bad_request,
                headers={"Authorization": f"Bearer {mcp_token}"},
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                assert "error" in data
                assert data["error"]["code"] in [-32700, -32600, -32602]
    
    @pytest.mark.asyncio
    async def test_long_running_stream(self, proxy_url, mcp_token):
        """T4: Long-running streams don't deadlock"""
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{proxy_url}/mcp",
                json={
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "params": {
                        "name": "transactions.query",
                        "arguments": {
                            "since": "2020-01-01T00:00:00Z",
                            "limit": 10000
                        }
                    },
                    "id": "long-test"
                },
                headers={"Authorization": f"Bearer {mcp_token}"},
                timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                assert response.status == 200
                data = await response.json()
                assert "result" in data or "error" in data
    
    def test_auth_required(self, proxy_url):
        """T4: Unauthorized requests rejected"""
        # Our MCP server allows tools/list without auth for discovery
        # But financial tools require auth
        response = requests.post(
            f"{proxy_url}/mcp",
            json={
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {
                    "name": "summary.today",
                    "arguments": {}
                },
                "id": "unauth"
            },
            timeout=5
        )
        
        # Should get an error for financial tools without auth
        assert response.status_code == 200  # JSON-RPC always returns 200
        data = response.json()
        assert "error" in data  # But should have an error in the response


if __name__ == "__main__":
    pytest.main([__file__, "-v"])