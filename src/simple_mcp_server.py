#!/usr/bin/env python3
"""
Simple MCP Server for testing
Implements basic JSON-RPC 2.0 over HTTP
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import os


class MCPHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        """Handle GET requests for health checks"""
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"OK")
        elif self.path == "/mcp/stream":
            # SSE endpoint
            import time
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            
            # Send a few test events with delays to demonstrate streaming
            for i in range(3):
                event = f"data: Event {i}\n\n"
                self.wfile.write(event.encode())
                self.wfile.flush()
                time.sleep(0.1)  # 100ms delay between events
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_POST(self):
        """Handle POST requests for JSON-RPC"""
        if self.path == "/mcp":
            # Read request body
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            
            try:
                request = json.loads(body)
            except json.JSONDecodeError:
                self.send_error(400, "Invalid JSON")
                return
            
            # Check for Enable Banking OAuth access token
            auth_header = self.headers.get("Authorization", "")
            method = request.get("method")
            params = request.get("params", {})
            tool_name = params.get("name") if method == "tools/call" else None
            
            # Allow tools/list and OAuth flow tools without token
            if method in ["tools/list"] or tool_name in ["enable.banking.auth", "enable.banking.callback"]:
                self._handle_mcp_request(request)
                return
            else:
                # All other tools require Enable Banking access token
                if not auth_header.startswith("Bearer "):
                    self.send_json_error(-32600, "Enable Banking access token required. Use enable.banking.auth first.", request.get("id"))
                    return
                
                access_token = auth_header[7:]  # Remove "Bearer " prefix
                # Store the access token for use in banking operations
                request["_access_token"] = access_token
                self._handle_mcp_request(request)
                return
        else:
            self.send_error(404)
    
    def _handle_mcp_request(self, request):
        """Handle MCP JSON-RPC request"""
        # Check for required JSON-RPC fields
        if "jsonrpc" not in request or request["jsonrpc"] != "2.0":
            self.send_json_error(-32600, "Invalid Request", request.get("id"))
            return
        
        if "method" not in request:
            self.send_json_error(-32600, "Invalid Request", request.get("id"))
            return
        
        # Handle methods
        method = request["method"]
        params = request.get("params", {})
        request_id = request.get("id")
        access_token = request.get("_access_token")  # Available for authenticated requests
        
        if method == "tools/list":
            # Return list of available tools
            result = {
                "tools": [
                    {"name": "summary.today", "description": "Get today's summary"},
                    {"name": "projection.month", "description": "Get monthly projection"},
                    {"name": "transactions.query", "description": "Query transactions"},
                    {"name": "enable.banking.auth", "description": "Start Enable Banking OAuth flow"},
                    {"name": "enable.banking.callback", "description": "Handle OAuth callback"},
                    {"name": "enable.banking.sync", "description": "Sync transactions from bank"}
                ]
            }
            self.send_json_result(result, request_id)
        
        elif method == "tools/call":
            # Handle tool invocation
            tool_name = params.get("name")
            tool_args = params.get("arguments", {})
            
            if tool_name == "summary.today":
                if not access_token:
                    self.send_json_error(-32600, "Enable Banking access token required", request_id)
                    return
                result = {
                    "summary": {
                        "date": "2024-01-15",
                        "total_spent": 127.43,
                        "categories": {
                            "groceries": 45.20,
                            "transport": 50.00
                        }
                    }
                }
            elif tool_name == "projection.month":
                if not access_token:
                    self.send_json_error(-32600, "Enable Banking access token required", request_id)
                    return
                result = {
                    "projection": {
                        "current_pace": 3823.00,
                        "monthly_budget": 3500.00,
                        "projected_balance": -323.00
                    }
                }
            elif tool_name == "transactions.query":
                if not access_token:
                    self.send_json_error(-32600, "Enable Banking access token required", request_id)
                    return
                result = {
                    "transactions": [
                        {"id": "1", "amount": 45.20, "merchant": "Tesco"},
                        {"id": "2", "amount": 50.00, "merchant": "TfL"}
                    ]
                }
            
            elif tool_name == "enable.banking.auth":
                # Start Enable Banking OAuth flow (no auth required)
                redirect_uri = tool_args.get("redirect_uri", "http://localhost:8082/api/auth/callback")
                state = tool_args.get("state", "mcp-inspector-test")
                
                # For sandbox, return mock auth URL
                auth_url = f"https://api.sandbox.enablebanking.com/auth/authorize?client_id=test&redirect_uri={redirect_uri}&state={state}"
                
                result = {
                    "auth_url": auth_url,
                    "message": "Open this URL in your browser to authorize",
                    "state": state
                }
            
            elif tool_name == "enable.banking.callback":
                # Handle OAuth callback (no auth required for this step)
                code = tool_args.get("code")
                state = tool_args.get("state")
                
                if not code:
                    result = {"error": "Missing authorization code"}
                else:
                    # Mock successful authentication
                    result = {
                        "status": "authenticated",
                        "access_token": "mock_access_token_12345",
                        "expires_in": 3600,
                        "message": "Successfully authenticated with Enable Banking. Use this access_token for subsequent MCP requests."
                    }
            
            elif tool_name == "enable.banking.sync":
                if not access_token:
                    self.send_json_error(-32600, "Enable Banking access token required", request_id)
                    return
                    
                # Sync transactions from bank (requires access token)
                result = {
                    "status": "synced",
                    "transactions_count": 5,
                    "accounts": ["GB123456789", "GB987654321"],
                    "message": f"Successfully synced 5 transactions from 2 accounts using token: {access_token[:10]}...",
                    "transactions": [
                        {"id": "eb-001", "amount": -45.20, "merchant": "Tesco", "date": "2024-01-15"},
                        {"id": "eb-002", "amount": -12.50, "merchant": "Costa", "date": "2024-01-15"},
                        {"id": "eb-003", "amount": -50.00, "merchant": "TfL", "date": "2024-01-14"},
                        {"id": "eb-004", "amount": 2500.00, "merchant": "Salary", "date": "2024-01-01"},
                        {"id": "eb-005", "amount": -800.00, "merchant": "Rent", "date": "2024-01-01"}
                    ]
                }
            
            else:
                self.send_json_error(-32601, f"Method not found: {tool_name}", request_id)
                return
            
            self.send_json_result(result, request_id)
        
        else:
            self.send_json_error(-32601, f"Method not found: {method}", request_id)
    
    def send_json_result(self, result, request_id):
        """Send JSON-RPC 2.0 result"""
        response = {
            "jsonrpc": "2.0",
            "result": result,
            "id": request_id
        }
        
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())
    
    def send_json_error(self, code, message, request_id):
        """Send JSON-RPC 2.0 error"""
        response = {
            "jsonrpc": "2.0",
            "error": {
                "code": code,
                "message": message
            },
            "id": request_id
        }
        
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())
    
    def log_message(self, format, *args):
        """Override to reduce logging"""
        pass


def main():
    port = int(os.getenv("MCP_PORT", 8081))
    server = HTTPServer(("", port), MCPHandler)
    print(f"MCP Server running on port {port}")
    server.serve_forever()


if __name__ == "__main__":
    main()