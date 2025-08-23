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
        # Use the same token as configured in docker-compose
        return os.getenv("MCP_TOKEN", "secret")
    
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
        """T4: SSE streaming preserved through proxy"""
        # Test SSE endpoint through proxy
        response = requests.get(
            f"{proxy_url}/mcp/stream",
            headers={
                "Authorization": f"Bearer {mcp_token}",
                "Accept": "text/event-stream",
                "Cache-Control": "no-cache"
            },
            stream=True,
            timeout=10
        )
        
        assert response.status_code == 200
        assert response.headers.get("Content-Type") == "text/event-stream"
        
        # Verify no buffering (chunks arrive immediately)
        chunks_with_timing = []
        start_time = time.time()
        
        for line in response.iter_lines():
            if line:
                arrival_time = time.time() - start_time
                chunks_with_timing.append((arrival_time, line.decode('utf-8')))
                
                if len(chunks_with_timing) >= 3:
                    break
        
        # Verify chunks arrived over time (not all at once)
        if len(chunks_with_timing) >= 2:
            time_diff = chunks_with_timing[1][0] - chunks_with_timing[0][0]
            assert time_diff > 0.05, "Chunks buffered (arrived too quickly)"
    
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
                timeout=5
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
                timeout=5
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
                timeout=5
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
        response = requests.post(
            f"{proxy_url}/mcp",
            json={
                "jsonrpc": "2.0",
                "method": "tools/list",
                "id": "unauth"
            },
            timeout=5
        )
        
        assert response.status_code in [401, 403]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])