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
            # Check authorization
            auth_header = self.headers.get("Authorization", "")
            expected_token = os.getenv("MCP_AUTH_TOKEN", "secret")
            
            if not auth_header.startswith(f"Bearer {expected_token}"):
                self.send_error(401, "Unauthorized")
                return
            
            # Read request body
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            
            try:
                request = json.loads(body)
            except json.JSONDecodeError:
                self.send_error(400, "Invalid JSON")
                return
            
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
            
            if method == "tools/list":
                # Return list of available tools
                result = {
                    "tools": [
                        {"name": "summary.today", "description": "Get today's summary"},
                        {"name": "projection.month", "description": "Get monthly projection"},
                        {"name": "transactions.query", "description": "Query transactions"}
                    ]
                }
                self.send_json_result(result, request_id)
            
            elif method == "tools/call":
                # Handle tool invocation
                tool_name = params.get("name")
                tool_args = params.get("arguments", {})
                
                if tool_name == "summary.today":
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
                    result = {
                        "projection": {
                            "current_pace": 3823.00,
                            "monthly_budget": 3500.00,
                            "projected_balance": -323.00
                        }
                    }
                elif tool_name == "transactions.query":
                    result = {
                        "transactions": [
                            {"id": "1", "amount": 45.20, "merchant": "Tesco"},
                            {"id": "2", "amount": 50.00, "merchant": "TfL"}
                        ]
                    }
                else:
                    self.send_json_error(-32601, f"Method not found: {tool_name}", request_id)
                    return
                
                self.send_json_result(result, request_id)
            
            else:
                self.send_json_error(-32601, f"Method not found: {method}", request_id)
        else:
            self.send_error(404)
    
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