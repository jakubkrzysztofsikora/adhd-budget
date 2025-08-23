"""
MCP Server Module
Implements T4 Gate: JSON-RPC 2.0 over SSE/HTTP (no WebSockets)
"""

import json
import asyncio
from typing import Dict, Any, Optional, AsyncIterator
from datetime import datetime


class MCPServer:
    """MCP JSON-RPC 2.0 server implementation"""
    
    def __init__(self, base_url: str = "http://localhost:8080/mcp"):
        """
        Initialize MCP server
        
        Args:
            base_url: Base URL for MCP endpoints
        """
        self.base_url = base_url
        self.tools = {
            "summary.today": self.handle_summary_today,
            "projection.month": self.handle_projection_month,
            "transactions.query": self.handle_transactions_query,
        }
    
    async def handle_jsonrpc(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle JSON-RPC 2.0 request
        
        Args:
            request: JSON-RPC request dict
            
        Returns:
            JSON-RPC response dict
        """
        # Validate JSON-RPC 2.0 format
        if request.get("jsonrpc") != "2.0":
            return self._error_response(
                request.get("id"),
                -32600,
                "Invalid Request: jsonrpc must be 2.0"
            )
        
        if "method" not in request:
            return self._error_response(
                request.get("id"),
                -32600,
                "Invalid Request: method is required"
            )
        
        method = request["method"]
        params = request.get("params", {})
        request_id = request.get("id")
        
        # Route methods
        if method == "tools/list":
            return self._success_response(request_id, await self.list_tools())
        elif method == "tools/call":
            return await self.call_tool(params, request_id)
        else:
            return self._error_response(
                request_id,
                -32601,
                f"Method not found: {method}"
            )
    
    async def list_tools(self) -> Dict[str, Any]:
        """List available tools"""
        return {
            "tools": [
                {"name": "summary.today", "description": "Get today's financial summary"},
                {"name": "projection.month", "description": "Get monthly spending projections"},
                {"name": "transactions.query", "description": "Query transactions"},
            ]
        }
    
    async def call_tool(self, params: Dict[str, Any], request_id: Any) -> Dict[str, Any]:
        """
        Call a specific tool
        
        Args:
            params: Tool call parameters
            request_id: JSON-RPC request ID
            
        Returns:
            JSON-RPC response
        """
        if not isinstance(params, dict):
            return self._error_response(
                request_id,
                -32602,
                "Invalid params: must be object"
            )
        
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        
        if tool_name not in self.tools:
            return self._error_response(
                request_id,
                -32602,
                f"Unknown tool: {tool_name}"
            )
        
        try:
            result = await self.tools[tool_name](arguments)
            return self._success_response(request_id, result)
        except Exception as e:
            return self._error_response(
                request_id,
                -32603,
                f"Internal error: {str(e)}"
            )
    
    async def handle_summary_today(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle summary.today tool call"""
        return {
            "date": datetime.now().isoformat(),
            "total_spent": 127.43,
            "categories": {
                "groceries": 45.20,
                "eating_out": 32.23,
                "transport": 50.00
            },
            "vs_budget": {
                "daily_budget": 100.00,
                "variance": 27.43,
                "status": "over"
            }
        }
    
    async def handle_projection_month(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle projection.month tool call"""
        return {
            "month": datetime.now().strftime("%Y-%m"),
            "projected_spend": 3823.00,
            "budget": 3500.00,
            "variance": 323.00,
            "pace": "over",
            "month_end_balance": -323.00
        }
    
    async def handle_transactions_query(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle transactions.query tool call"""
        since = args.get("since", "2024-01-01T00:00:00Z")
        limit = args.get("limit", 100)
        
        return {
            "transactions": [
                {
                    "id": "tx_001",
                    "date": "2024-01-15T10:30:00Z",
                    "amount": 45.20,
                    "merchant": "Tesco",
                    "category": "groceries"
                }
            ],
            "count": 1,
            "since": since,
            "limit": limit
        }
    
    async def stream_sse(self, method: str, params: Dict[str, Any]) -> AsyncIterator[str]:
        """
        Stream SSE responses
        
        Args:
            method: Method to call
            params: Method parameters
            
        Yields:
            SSE formatted strings
        """
        # Simulate streaming response
        for i in range(3):
            chunk = {
                "id": i,
                "type": "progress",
                "data": f"Processing chunk {i+1}/3"
            }
            yield f"data: {json.dumps(chunk)}\n\n"
            await asyncio.sleep(0.1)
        
        # Final result
        result = await self.handle_jsonrpc({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": "stream"
        })
        yield f"data: {json.dumps(result)}\n\n"
    
    def _success_response(self, request_id: Any, result: Any) -> Dict[str, Any]:
        """Create success response"""
        return {
            "jsonrpc": "2.0",
            "result": result,
            "id": request_id
        }
    
    def _error_response(self, request_id: Any, code: int, message: str) -> Dict[str, Any]:
        """Create error response"""
        return {
            "jsonrpc": "2.0",
            "error": {
                "code": code,
                "message": message
            },
            "id": request_id
        }