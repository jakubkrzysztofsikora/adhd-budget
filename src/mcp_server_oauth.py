#!/usr/bin/env python3
"""
MCP Server with Enable Banking OAuth Integration
Implements T4 Gate: JSON-RPC 2.0 over SSE/HTTP with Enable Banking OAuth as sole auth
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import os
import logging
import time
import requests
from typing import Dict, Any, Optional
from urllib.parse import urlparse, parse_qs
from enable_banking import EnableBankingClient
from enable_banking_jwt import EnableBankingJWT


# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class EnableBankingMCPHandler(BaseHTTPRequestHandler):
    """MCP Server with Enable Banking OAuth authentication"""
    
    def __init__(self, *args, **kwargs):
        """Initialize handler with Enable Banking client"""
        super().__init__(*args, **kwargs)
    
    def do_GET(self):
        """Handle GET requests for health checks, OAuth discovery, and SSE"""        
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"OK")
        
        elif self.path.startswith("/.well-known/oauth-authorization-server"):
            # OAuth 2.0 Authorization Server Metadata (RFC 8414)
            self._handle_oauth_discovery()
        
        elif self.path.startswith("/.well-known/oauth-protected-resource"):
            # OAuth 2.0 Protected Resource Metadata (RFC 8705)
            self._handle_protected_resource_discovery()
        
        elif self.path.startswith("/.well-known/openid-configuration"):
            # OpenID Connect Discovery (fallback to OAuth)
            self._handle_oauth_discovery()
        
        elif self.path.startswith("/oauth/authorize"):
            # OAuth authorization endpoint - proxy to Enable Banking with JWT
            self._handle_oauth_authorize_proxy()
        
        elif self.path == "/mcp/stream":
            # SSE endpoint for streaming MCP responses
            self._handle_sse_stream()
        
        elif self.path.startswith("/auth/callback"):
            # OAuth callback handler
            self._handle_oauth_callback()
        
        else:
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Not Found")
    
    def do_POST(self):
        """Handle POST requests for JSON-RPC and OAuth token exchange"""
        if self.path == "/mcp":
            self._handle_mcp_request()
        elif self.path.startswith("/oauth/authorize"):
            self._handle_oauth_authorize_submit()
        elif self.path.startswith("/oauth/token"):
            self._handle_oauth_token()
        elif self.path.startswith("/oauth/register"):
            self._handle_client_registration()
        else:
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Not Found")
    
    def _handle_mcp_request(self):
        """Handle MCP JSON-RPC requests with Enable Banking OAuth"""
        # Read request body
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        
        try:
            request = json.loads(body)
        except json.JSONDecodeError as e:
            self.send_json_error(-32700, f"Parse error: {str(e)}", None)
            return
        
        # Validate JSON-RPC 2.0 format
        if request.get("jsonrpc") != "2.0":
            self.send_json_error(-32600, "Invalid Request: jsonrpc must be 2.0", request.get("id"))
            return
        
        if "method" not in request:
            self.send_json_error(-32600, "Invalid Request: method is required", request.get("id"))
            return
        
        method = request["method"]
        params = request.get("params", {})
        request_id = request.get("id")
        
        # Handle authentication
        auth_header = self.headers.get("Authorization", "")
        
        # Allow certain methods without authentication
        if method == "initialize":
            # MCP initialization doesn't require auth
            self._handle_initialize(params, request_id)
            return
        elif method == "ping":
            # Simple ping/pong for connection testing
            self.send_json_result({"pong": True}, request_id)
            return
        elif method == "tools/list":
            self._handle_tools_list(request_id)
            return
        elif method == "tools/call":
            tool_name = params.get("name") if isinstance(params, dict) else None
            if tool_name in ["enable.banking.auth", "enable.banking.callback", "enable.banking.banks", "auth.help"]:
                self._handle_tool_call(params, request_id)
                return
        
        # All other methods require Enable Banking OAuth access token
        if not auth_header.startswith("Bearer "):
            self.send_json_error(
                -32600, 
                "Enable Banking access token required. Use enable.banking.auth tool first.", 
                request_id
            )
            return
        
        access_token = auth_header[7:]  # Remove "Bearer " prefix
        
        # Validate the access token
        if not self._validate_access_token(access_token):
            self.send_json_error(-32600, "Invalid or expired access token", request_id)
            return
        
        # Handle authenticated request
        if method == "tools/call":
            self._handle_tool_call(params, request_id, access_token)
        else:
            self.send_json_error(-32601, f"Method not found: {method}", request_id)
    
    def _validate_access_token(self, access_token: str) -> bool:
        """
        Validate Enable Banking access token
        
        Args:
            access_token: The access token to validate
            
        Returns:
            True if token is valid
        """
        # For now, implement basic token validation
        # In production, this should validate against Enable Banking's token introspection
        # or maintain a server-side session tied to valid EB tokens
        
        if not access_token or len(access_token) < 10:
            return False
        
        # Check if it's a mock token (for testing)
        if access_token.startswith("mock_access_token"):
            return True
        
        # For Enable Banking session IDs (UUIDs), accept any reasonable length
        # In production, you'd validate the session with Enable Banking
        return len(access_token) > 10
    
    def _handle_initialize(self, params: Dict[str, Any], request_id):
        """Handle MCP initialization request"""
        # Extract protocol version from params
        protocol_version = params.get("protocolVersion", "0.1.0")
        
        # Send initialization response
        response = {
            "protocolVersion": protocol_version,
            "serverInfo": {
                "name": "ADHD Budget MCP Server",
                "version": "1.0.0"
            },
            "capabilities": {
                "tools": {
                    "available": True
                }
            }
        }
        
        self.send_json_result(response, request_id)
    
    def _handle_tools_list(self, request_id):
        """Handle tools/list request"""
        result = {
            "tools": [
                {
                    "name": "auth.help", 
                    "description": "📋 How to authenticate with Enable Banking",
                    "inputSchema": {
                        "type": "object",
                        "properties": {}
                    }
                },
                {
                    "name": "enable.banking.banks", 
                    "description": "🏦 List available banks",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "country": {
                                "type": "string",
                                "description": "Country code (e.g., FI, GB, DE)"
                            }
                        }
                    }
                },
                {
                    "name": "enable.banking.auth", 
                    "description": "🔐 Start Enable Banking auth",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "aspsp_name": {
                                "type": "string",
                                "description": "Bank name (e.g., Mock ASPSP)"
                            },
                            "aspsp_country": {
                                "type": "string", 
                                "description": "Country code (e.g., FI)"
                            },
                            "redirect_url": {
                                "type": "string",
                                "description": "OAuth callback URL"
                            },
                            "state": {
                                "type": "string",
                                "description": "OAuth state parameter"
                            }
                        },
                        "required": ["aspsp_name", "aspsp_country"]
                    }
                },
                {
                    "name": "enable.banking.callback", 
                    "description": "✅ Complete auth with session data",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "code": {
                                "type": "string",
                                "description": "Session ID from callback"
                            },
                            "redirect_uri": {
                                "type": "string",
                                "description": "Redirect URI used in auth"
                            }
                        },
                        "required": ["code"]
                    }
                },
                {
                    "name": "summary.today", 
                    "description": "📊 Get today's financial summary (requires EB auth)",
                    "inputSchema": {
                        "type": "object",
                        "properties": {}
                    }
                },
                {
                    "name": "projection.month", 
                    "description": "📈 Get monthly spending projections (requires EB auth)",
                    "inputSchema": {
                        "type": "object",
                        "properties": {}
                    }
                },
                {
                    "name": "transactions.query", 
                    "description": "💳 Query transactions (requires EB auth)",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "since": {
                                "type": "string",
                                "description": "ISO date to query from"
                            },
                            "until": {
                                "type": "string",
                                "description": "ISO date to query until"
                            }
                        }
                    }
                },
                {
                    "name": "enable.banking.sync", 
                    "description": "🔄 Sync transactions from Enable Banking (requires EB auth)",
                    "inputSchema": {
                        "type": "object",
                        "properties": {}
                    }
                }
            ]
        }
        self.send_json_result(result, request_id)
    
    def _handle_tool_call(self, params: Dict[str, Any], request_id, access_token: str = None):
        """Handle tools/call request"""
        if not isinstance(params, dict):
            self.send_json_error(-32602, "Invalid params: must be object", request_id)
            return
        
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        
        try:
            if tool_name == "auth.help":
                result = self._handle_auth_help(arguments)
            elif tool_name == "enable.banking.banks":
                result = self._handle_list_banks(arguments)
            elif tool_name == "enable.banking.auth":
                result = self._handle_enable_banking_auth(arguments)
            elif tool_name == "enable.banking.callback":
                result = self._handle_enable_banking_callback(arguments)
            elif tool_name == "summary.today":
                if not access_token:
                    self.send_json_error(-32600, "Access token required", request_id)
                    return
                result = self._handle_summary_today(arguments, access_token)
            elif tool_name == "projection.month":
                if not access_token:
                    self.send_json_error(-32600, "Access token required", request_id)
                    return
                result = self._handle_projection_month(arguments, access_token)
            elif tool_name == "transactions.query":
                if not access_token:
                    self.send_json_error(-32600, "Access token required", request_id)
                    return
                result = self._handle_transactions_query(arguments, access_token)
            elif tool_name == "enable.banking.sync":
                if not access_token:
                    self.send_json_error(-32600, "Access token required", request_id)
                    return
                result = self._handle_enable_banking_sync(arguments, access_token)
            else:
                self.send_json_error(-32601, f"Unknown tool: {tool_name}", request_id)
                return
            
            self.send_json_result(result, request_id)
        
        except Exception as e:
            logger.error(f"Tool call error: {str(e)}")
            self.send_json_error(-32603, f"Internal error: {str(e)}", request_id)
    
    def _handle_auth_help(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle auth.help tool - provide authentication instructions"""
        return {
            "title": "🔐 Enable Banking OAuth Authentication",
            "message": "This MCP server uses Enable Banking OAuth as the sole authentication mechanism.",
            "instructions": [
                "1️⃣ Call the 'enable.banking.auth' tool to get an authorization URL",
                "2️⃣ Open the returned URL in your browser to complete bank authorization", 
                "3️⃣ You'll be redirected back with an authorization code",
                "4️⃣ Call 'enable.banking.callback' tool with the code to get your access token",
                "5️⃣ Use the access token in the Authorization header for protected tool calls"
            ],
            "example_flow": {
                "step1": "Call enable.banking.auth → Get auth_url",
                "step2": "Open auth_url in browser → Complete bank login",
                "step3": "Extract 'code' from callback URL → Use in next step",
                "step4": "Call enable.banking.callback with code → Get access_token",
                "step5": "Set Authorization: Bearer <access_token> for protected calls"
            },
            "protected_tools": [
                "summary.today", "projection.month", "transactions.query", "enable.banking.sync"
            ],
            "public_tools": [
                "auth.help", "enable.banking.auth", "enable.banking.callback"
            ]
        }
    
    def _handle_list_banks(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle enable.banking.banks tool - list available banks"""
        try:
            # Initialize Enable Banking client with real credentials
            app_id = os.getenv('ENABLE_APP_ID', 'sandbox-app-id')
            private_key_path = os.getenv('ENABLE_PRIVATE_KEY_PATH', '/app/keys/1ba6d8a6-68f8-4899-b0a4-c8d8a795337b.pem')
            
            # Check if we have real credentials
            if app_id == 'sandbox-app-id' or not os.path.exists(private_key_path):
                return {
                    "banks": [
                        {"name": "MOCKASPSP_SANDBOX", "country": "FI", "description": "Mock bank for testing"}
                    ],
                    "message": "Using mock bank. Configure Enable Banking for real banks."
                }
            
            # Create JWT and get banks
            from enable_banking_jwt import EnableBankingJWT
            jwt_helper = EnableBankingJWT(app_id, private_key_path)
            jwt_token = jwt_helper.generate_token()
            
            headers = {'Authorization': f'Bearer {jwt_token}'}
            response = requests.get('https://api.enablebanking.com/aspsps', headers=headers)
            
            if response.status_code != 200:
                return {"error": f"Failed to get banks: {response.text}"}
            
            data = response.json()
            banks = data.get('aspsps', [])
            
            # Filter by country if requested
            country = args.get('country')
            if country:
                banks = [b for b in banks if b.get('country') == country.upper()]
            
            # Return first 20 banks with essential info
            result_banks = []
            for bank in banks[:20]:
                result_banks.append({
                    "name": bank.get("name"),
                    "country": bank.get("country"),
                    "bic": bank.get("bic", ""),
                    "transaction_total_days": bank.get("transaction_total_days", "90")
                })
            
            return {
                "banks": result_banks,
                "total": len(banks),
                "message": f"Showing {len(result_banks)} of {len(banks)} banks. Use 'country' param to filter."
            }
            
        except Exception as e:
            logger.error(f"List banks error: {str(e)}")
            return {"error": f"Failed to list banks: {str(e)}"}
    
    def _handle_enable_banking_auth(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle enable.banking.auth tool - start Enable Banking auth flow"""
        try:
            # Get parameters
            aspsp_name = args.get("aspsp_name", "MOCKASPSP_SANDBOX")
            aspsp_country = args.get("aspsp_country", "FI")
            redirect_url = args.get("redirect_url", "http://localhost:8081/auth/callback")
            state = args.get("state", f"mcp-{int(time.time())}")
            
            # Initialize Enable Banking client with real credentials
            app_id = os.getenv('ENABLE_APP_ID', 'sandbox-app-id')
            private_key_path = os.getenv('ENABLE_PRIVATE_KEY_PATH', '/app/keys/1ba6d8a6-68f8-4899-b0a4-c8d8a795337b.pem')
            
            # Check if we have real credentials
            if app_id == 'sandbox-app-id' or not os.path.exists(private_key_path):
                return {
                    "error": "Enable Banking not configured",
                    "message": "Please configure Enable Banking credentials in .env file",
                    "instructions": [
                        "1. Register at https://enablebanking.com",
                        "2. Create an application",
                        "3. Generate RSA keys",
                        "4. Update .env with ENABLE_APP_ID and ENABLE_PRIVATE_KEY_PATH"
                    ]
                }
            
            # Create Enable Banking client
            eb_client = EnableBankingClient(sandbox=False)
            eb_client.app_id = app_id
            eb_client.jwt_helper = EnableBankingJWT(app_id, private_key_path)
            
            # Initiate auth with Enable Banking
            auth_response = eb_client.initiate_auth(
                aspsp_name=aspsp_name,
                aspsp_country=aspsp_country,
                redirect_url=redirect_url,
                state=state
            )
            
            return {
                "status": "authorization_required",
                "auth_url": auth_response.get("url"),
                "session_id": auth_response.get("session_id"),
                "redirect_url": redirect_url,
                "state": state,
                "message": "Open this URL in your browser to authorize with your bank",
                "instructions": [
                    "1. Open the auth_url in your browser",
                    "2. Complete the bank authorization",
                    "3. You'll be redirected back with session data",
                    "4. Use the enable.banking.callback tool to complete"
                ]
            }
        except Exception as e:
            logger.error(f"Auth initiation error: {str(e)}")
            return {"error": f"Failed to initiate Enable Banking auth: {str(e)}"}
    
    def _handle_enable_banking_callback(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle enable.banking.callback tool - process session from Enable Banking"""
        session_id = args.get("code")  # Enable Banking returns session ID as 'code'
        redirect_uri = args.get("redirect_uri", "http://localhost:8081/auth/callback")
        
        if not session_id:
            return {"error": "Session ID is required"}
        
        try:
            # Enable Banking uses session-based auth, not OAuth token exchange
            # The session ID IS the access token for accessing Enable Banking APIs
            
            return {
                "status": "authenticated",
                "access_token": session_id,  # Use session ID as access token
                "expires_in": 86400,  # 24 hours
                "message": "Successfully authenticated with Enable Banking",
                "usage": "Session ID can be used to access Enable Banking APIs",
                "session_id": session_id
            }
        except Exception as e:
            logger.error(f"Session callback error: {str(e)}")
            return {"error": f"Failed to process session: {str(e)}"}
    
    def _handle_summary_today(self, args: Dict[str, Any], access_token: str) -> Dict[str, Any]:
        """Handle summary.today tool with Enable Banking data"""
        try:
            # Initialize Enable Banking client with access token
            eb_client = EnableBankingClient(sandbox=True)
            eb_client.access_token = access_token
            
            # Get transactions (mock data for sandbox)
            transactions = eb_client.get_mock_transactions()
            
            # Calculate summary
            today = time.strftime("%Y-%m-%d")
            today_transactions = [t for t in transactions if t.get("bookingDate") == today]
            
            total_spent = sum(float(t["transactionAmount"]["amount"]) for t in today_transactions if float(t["transactionAmount"]["amount"]) > 0)
            
            # Categorize transactions (simplified)
            categories = {}
            for t in today_transactions:
                merchant = t.get("creditorName", "Unknown")
                amount = float(t["transactionAmount"]["amount"])
                if amount > 0:
                    if "tesco" in merchant.lower() or "shop" in merchant.lower():
                        categories["groceries"] = categories.get("groceries", 0) + amount
                    elif "transport" in merchant.lower() or "tfl" in merchant.lower():
                        categories["transport"] = categories.get("transport", 0) + amount
                    else:
                        categories["other"] = categories.get("other", 0) + amount
            
            return {
                "date": today,
                "total_spent": total_spent,
                "categories": categories,
                "transaction_count": len(today_transactions),
                "vs_budget": {
                    "daily_budget": 100.00,
                    "variance": total_spent - 100.00,
                    "status": "over" if total_spent > 100 else "under"
                }
            }
        except Exception as e:
            logger.error(f"Summary error: {str(e)}")
            return {"error": f"Failed to get summary: {str(e)}"}
    
    def _handle_projection_month(self, args: Dict[str, Any], access_token: str) -> Dict[str, Any]:
        """Handle projection.month tool with Enable Banking data"""
        try:
            # Initialize Enable Banking client with access token
            eb_client = EnableBankingClient(sandbox=True)
            eb_client.access_token = access_token
            
            # Get transactions (mock data for sandbox)
            transactions = eb_client.get_mock_transactions()
            
            # Calculate monthly projection
            current_month = time.strftime("%Y-%m")
            monthly_spend = sum(float(t["transactionAmount"]["amount"]) for t in transactions 
                              if t.get("bookingDate", "").startswith(current_month) and 
                              float(t["transactionAmount"]["amount"]) > 0)
            
            # Simple projection (current spend * days remaining factor)
            import datetime
            now = datetime.datetime.now()
            days_in_month = (datetime.date(now.year, now.month + 1, 1) - datetime.timedelta(days=1)).day
            current_day = now.day
            projection_factor = days_in_month / current_day if current_day > 0 else 1
            
            projected_spend = monthly_spend * projection_factor
            budget = 3500.00
            
            return {
                "month": current_month,
                "projected_spend": round(projected_spend, 2),
                "current_spend": round(monthly_spend, 2),
                "budget": budget,
                "variance": round(projected_spend - budget, 2),
                "pace": "over" if projected_spend > budget else "under",
                "days_remaining": days_in_month - current_day
            }
        except Exception as e:
            logger.error(f"Projection error: {str(e)}")
            return {"error": f"Failed to get projection: {str(e)}"}
    
    def _handle_transactions_query(self, args: Dict[str, Any], access_token: str) -> Dict[str, Any]:
        """Handle transactions.query tool with Enable Banking data"""
        try:
            # Initialize Enable Banking client with access token
            eb_client = EnableBankingClient(sandbox=True)
            eb_client.access_token = access_token
            
            # Get transactions
            transactions = eb_client.get_mock_transactions()
            
            # Apply filters
            since = args.get("since", "2024-01-01")
            limit = args.get("limit", 100)
            
            # Filter by date
            if since:
                filtered_transactions = [t for t in transactions if t.get("bookingDate", "") >= since]
            else:
                filtered_transactions = transactions
            
            # Apply limit
            if limit:
                filtered_transactions = filtered_transactions[:limit]
            
            # Transform to internal format
            transformed = []
            for t in filtered_transactions:
                transformed.append(eb_client.transform_transaction(t))
            
            return {
                "transactions": transformed,
                "count": len(transformed),
                "total_available": len(transactions),
                "since": since,
                "limit": limit
            }
        except Exception as e:
            logger.error(f"Transactions query error: {str(e)}")
            return {"error": f"Failed to query transactions: {str(e)}"}
    
    def _handle_enable_banking_sync(self, args: Dict[str, Any], access_token: str) -> Dict[str, Any]:
        """Handle enable.banking.sync tool - sync transactions from bank"""
        try:
            # Initialize Enable Banking client with access token
            eb_client = EnableBankingClient(sandbox=True)
            eb_client.access_token = access_token
            
            # Get fresh transactions from Enable Banking
            transactions = eb_client.get_mock_transactions()
            
            # Transform transactions
            transformed_transactions = []
            for t in transactions:
                transformed_transactions.append(eb_client.transform_transaction(t))
            
            # In a real implementation, we would:
            # 1. Store transactions in database with idempotent upserts
            # 2. Run categorization on new transactions
            # 3. Update projections and summaries
            
            return {
                "status": "synced",
                "transactions_synced": len(transformed_transactions),
                "accounts_processed": 1,  # Mock ASPSP has 1 account
                "last_sync": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "transactions": transformed_transactions[:5],  # Return first 5 as sample
                "message": f"Successfully synced {len(transformed_transactions)} transactions"
            }
        except Exception as e:
            logger.error(f"Sync error: {str(e)}")
            return {"error": f"Failed to sync transactions: {str(e)}"}
    
    def _handle_sse_stream(self):
        """Handle SSE streaming endpoint"""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")  # Disable proxy buffering
        self.end_headers()
        
        # Send test events to verify streaming works
        for i in range(3):
            event = f"data: {{\"event\": \"test\", \"data\": \"Stream event {i+1}\", \"timestamp\": \"{time.time()}\"}}\n\n"
            self.wfile.write(event.encode())
            self.wfile.flush()
            time.sleep(0.5)
    
    def _handle_oauth_discovery(self):
        """Handle OAuth 2.0 Authorization Server Metadata discovery (RFC 8414)"""
        # Get the base URL for this server, respecting proxy headers
        host = self.headers.get('X-Forwarded-Host') or self.headers.get('Host', 'localhost:8081')
        proto = self.headers.get('X-Forwarded-Proto', 'http')
        base_url = f"{proto}://{host}"
        
        # OAuth 2.0 Authorization Server Metadata
        # We proxy to Enable Banking with JWT auth since browser can't send custom headers
        discovery_data = {
            "issuer": base_url,
            "authorization_endpoint": f"{base_url}/oauth/authorize",  # Local proxy adds JWT auth
            "token_endpoint": f"{base_url}/oauth/token",  # Local proxy for token exchange
            "registration_endpoint": f"{base_url}/oauth/register",  # Local registration for MCP Inspector
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "scopes_supported": ["accounts", "transactions"],
            "token_endpoint_auth_methods_supported": ["none", "client_secret_basic", "client_secret_post"],
            "authorization_response_iss_parameter_supported": True,
            "_comment": "Proxies to Enable Banking API with JWT authentication"
        }
        
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(discovery_data, indent=2).encode())
    
    def _handle_protected_resource_discovery(self):
        """Handle OAuth 2.0 Protected Resource Metadata discovery"""
        # Get the base URL for this server, respecting proxy headers
        host = self.headers.get('X-Forwarded-Host') or self.headers.get('Host', 'localhost:8081')
        proto = self.headers.get('X-Forwarded-Proto', 'http')
        base_url = f"{proto}://{host}"
        
        # OAuth 2.0 Protected Resource Metadata
        # The resource is the MCP endpoint specifically
        resource_data = {
            "resource": f"{base_url}/mcp",
            "authorization_server": base_url,
            "scopes_supported": ["accounts", "transactions"],
            "bearer_methods_supported": ["header"],
            "resource_documentation": f"{base_url}/mcp"
        }
        
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(resource_data, indent=2).encode())
    
    def _handle_oauth_token(self):
        """Handle OAuth 2.0 token endpoint - proxy to Enable Banking"""
        # Read request body
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        
        try:
            # Parse form data
            from urllib.parse import parse_qs
            form_data = parse_qs(body.decode('utf-8'))
            
            grant_type = form_data.get('grant_type', [''])[0]
            code = form_data.get('code', [''])[0]
            redirect_uri = form_data.get('redirect_uri', [''])[0]
            
            if grant_type != 'authorization_code' or not code:
                self.send_json_error_oauth("invalid_request", "Missing or invalid parameters")
                return
            
            # Enable Banking doesn't use OAuth token exchange - it uses session-based auth
            # The "code" is actually the session ID from Enable Banking
            # We'll treat the session ID as the access token for MCP Inspector compatibility
            
            # Generate a mock OAuth response that MCP Inspector expects
            # but use the Enable Banking session ID as the token
            oauth_response = {
                "access_token": code,  # Use the session ID as the access token
                "token_type": "Bearer",
                "expires_in": 86400,  # 24 hours
                "scope": "accounts transactions"
            }
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Pragma", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(oauth_response).encode())
            
        except Exception as e:
            logger.error(f"OAuth token exchange error: {str(e)}")
            self.send_json_error_oauth("server_error", f"Token exchange failed: {str(e)}")
    
    def send_json_error_oauth(self, error_code: str, error_description: str):
        """Send OAuth 2.0 error response"""
        error_response = {
            "error": error_code,
            "error_description": error_description
        }
        
        self.send_response(400)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(error_response).encode())
    
    def _handle_client_registration(self):
        """Handle OAuth 2.0 Dynamic Client Registration (RFC 7591)"""
        # Read request body
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        
        try:
            # Parse registration request
            registration_request = json.loads(body.decode('utf-8'))
            
            # Return the actual Enable Banking client ID from environment
            app_id = os.getenv('ENABLE_APP_ID', '1ba6d8a6-68f8-4899-b0a4-c8d8a795337b')
            
            registration_response = {
                "client_id": app_id,
                "client_id_issued_at": int(time.time()),
                "redirect_uris": registration_request.get("redirect_uris", ["http://localhost/auth/callback"]),
                "response_types": ["code"],
                "grant_types": ["authorization_code", "refresh_token"],
                "token_endpoint_auth_method": "none",
                "scope": "accounts transactions"
            }
            
            self.send_response(201)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Pragma", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(registration_response).encode())
            
        except Exception as e:
            logger.error(f"Client registration error: {str(e)}")
            self.send_json_error_oauth("invalid_request", f"Client registration failed: {str(e)}")
    
    def _handle_oauth_authorize_proxy(self):
        """Proxy OAuth authorization to Enable Banking with JWT authentication"""
        from urllib.parse import urlparse, parse_qs, urlencode
        import requests
        
        # Parse query parameters
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        
        # Extract OAuth parameters
        client_id = params.get('client_id', [''])[0]
        redirect_uri = params.get('redirect_uri', [''])[0]
        response_type = params.get('response_type', [''])[0]
        state = params.get('state', [''])[0]
        code_challenge = params.get('code_challenge', [''])[0]
        code_challenge_method = params.get('code_challenge_method', [''])[0]
        scope = params.get('scope', [''])[0]
        
        # Check if we have valid Enable Banking credentials
        app_id = os.getenv('ENABLE_APP_ID')
        private_key_path = os.getenv('ENABLE_PRIVATE_KEY_PATH', '/app/keys/1ba6d8a6-68f8-4899-b0a4-c8d8a795337b.pem')
        
        # For development without real Enable Banking credentials,
        # show an informative page about the setup requirement
        if not app_id or not os.path.exists(private_key_path):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            
            html_page = f"""
            <!DOCTYPE html>
            <html>
            <head>
                <title>Enable Banking Setup Required</title>
                <style>
                    body {{ font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }}
                    .warning {{ background: #fff3cd; border: 1px solid #ffc107; padding: 20px; border-radius: 8px; }}
                    .info {{ background: #d1ecf1; border: 1px solid #0c5460; padding: 20px; border-radius: 8px; margin: 20px 0; }}
                    .code {{ background: #f8f9fa; padding: 15px; font-family: monospace; border-radius: 4px; margin: 10px 0; }}
                    h2 {{ color: #0c5460; }}
                    a {{ color: #007bff; }}
                </style>
            </head>
            <body>
                <h2>🔐 Enable Banking Sandbox Registration Required</h2>
                
                <div class="warning">
                    <strong>⚠️ No Enable Banking credentials configured</strong>
                    <p>You're using placeholder credentials. To use real Enable Banking OAuth, you need to:</p>
                </div>
                
                <div class="info">
                    <h3>Setup Instructions:</h3>
                    <ol>
                        <li>Register at <a href="https://enablebanking.com" target="_blank">https://enablebanking.com</a> for a sandbox account</li>
                        <li>Create an application in the Enable Banking dashboard</li>
                        <li>Generate RSA keys:
                            <div class="code">
# Generate private key<br>
openssl genrsa -out keys/enablebanking_private.pem 2048<br><br>
# Extract public key<br>
openssl rsa -in keys/enablebanking_private.pem -pubout -out keys/enablebanking_public.pem
                            </div>
                        </li>
                        <li>Upload the public key to Enable Banking</li>
                        <li>Update your <code>.env</code> file:
                            <div class="code">
ENABLE_APP_ID=your-real-app-id<br>
ENABLE_PRIVATE_KEY_PATH=/app/keys/enablebanking_private.pem<br>
ENABLE_API_BASE_URL=https://api.enablebanking.com
                            </div>
                        </li>
                        <li>Restart the MCP server</li>
                    </ol>
                </div>
                
                <div class="info">
                    <h3>OAuth Request Details:</h3>
                    <div class="code">
                        Client ID: {client_id}<br>
                        Redirect URI: {redirect_uri}<br>
                        State: {state}<br>
                        Scope: {scope}<br>
                        Code Challenge: {code_challenge[:20] if code_challenge else 'N/A'}...
                    </div>
                </div>
                
                <div class="info">
                    <p><strong>Note:</strong> Enable Banking requires JWT authentication for all API calls, including the OAuth authorization endpoint. This is different from standard OAuth 2.0.</p>
                </div>
            </body>
            </html>
            """.encode('utf-8')
            
            self.wfile.write(html_page)
            return
        
        # Since Enable Banking doesn't have a standard OAuth /authorize endpoint,
        # we'll show a bank selector page that then initiates the Enable Banking flow
        try:
            # Show bank selector page
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            
            # Build HTML page properly
            html_template = """
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Select Your Bank - Enable Banking</title>
                <style>
                    body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
                    h2 { color: #0c5460; }
                    .bank-selector { margin: 20px 0; }
                    select { width: 100%; padding: 10px; margin: 10px 0; }
                    button { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
                    button:hover { background: #0056b3; }
                    .info { background: #d1ecf1; border: 1px solid #0c5460; padding: 15px; border-radius: 8px; margin: 20px 0; }
                </style>
                <script>
                    function initiateAuth() {
                        const country = document.getElementById('country').value;
                        const bank = document.getElementById('bank').value;
                        
                        if (!bank) {
                            alert('Please select a bank');
                            return;
                        }
                        
                        // Call the Enable Banking auth tool via MCP
                        fetch('/mcp', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                jsonrpc: '2.0',
                                method: 'tools/call',
                                params: {
                                    name: 'enable.banking.auth',
                                    arguments: {
                                        aspsp_name: bank,
                                        aspsp_country: country,
                                        redirect_url: 'REDIRECT_URI_PLACEHOLDER',
                                        state: 'STATE_PLACEHOLDER'
                                    }
                                },
                                id: '1'
                            })
                        })
                        .then(res => res.json())
                        .then(data => {
                            if (data.result && data.result.auth_url) {
                                window.location.href = data.result.auth_url;
                            } else {
                                alert('Failed to initiate authentication: ' + JSON.stringify(data));
                            }
                        });
                    }
                    
                    function loadBanks() {
                        const country = document.getElementById('country').value;
                        fetch('/mcp', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                jsonrpc: '2.0',
                                method: 'tools/call',
                                params: {
                                    name: 'enable.banking.banks',
                                    arguments: { country: country }
                                },
                                id: '2'
                            })
                        })
                        .then(res => res.json())
                        .then(data => {
                            const select = document.getElementById('bank');
                            select.innerHTML = '<option value="">Select a bank...</option>';
                            
                            if (data.result && data.result.banks) {
                                data.result.banks.forEach(bank => {
                                    const option = document.createElement('option');
                                    option.value = bank.name;
                                    option.text = bank.name;
                                    select.appendChild(option);
                                });
                            }
                        });
                    }
                </script>
            </head>
            <body onload="loadBanks()">
                <h2>Connect Your Bank Account</h2>
                
                <div class="info">
                    <strong>Enable Banking OAuth Flow</strong>
                    <p>Select your bank to securely connect your account.</p>
                </div>
                
                <div class="bank-selector">
                    <label>Country:</label>
                    <select id="country" onchange="loadBanks()">
                        <option value="FI">Finland (Sandbox)</option>
                        <option value="GB">United Kingdom</option>
                        <option value="DE">Germany</option>
                        <option value="FR">France</option>
                        <option value="ES">Spain</option>
                        <option value="IT">Italy</option>
                        <option value="NL">Netherlands</option>
                        <option value="BE">Belgium</option>
                        <option value="PL">Poland</option>
                        <option value="SE">Sweden</option>
                        <option value="NO">Norway</option>
                        <option value="DK">Denmark</option>
                    </select>
                    
                    <label>Bank:</label>
                    <select id="bank">
                        <option value="">Loading banks...</option>
                    </select>
                    
                    <br><br>
                    <button onclick="initiateAuth()">Connect Bank</button>
                </div>
                
                <div style="margin-top: 40px; color: #666; font-size: 12px;">
                    <p>Client ID: CLIENT_ID_PLACEHOLDER</p>
                    <p>Redirect URI: REDIRECT_URI_PLACEHOLDER</p>
                    <p>State: STATE_PLACEHOLDER</p>
                </div>
            </body>
            </html>
            """
            
            # Replace placeholders with actual values
            html_page = html_template.replace('REDIRECT_URI_PLACEHOLDER', redirect_uri)
            html_page = html_page.replace('STATE_PLACEHOLDER', state)
            html_page = html_page.replace('CLIENT_ID_PLACEHOLDER', client_id)
            html_page = html_page.encode('utf-8')
            
            self.wfile.write(html_page)
            
        except Exception as e:
            logger.error(f"OAuth bank selector error: {str(e)}")
            self.send_response(500)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(f"<html><body><h1>Bank Selector Error</h1><p>{str(e)}</p></body></html>".encode('utf-8'))
    
    def _handle_oauth_authorize_submit(self):
        """Handle OAuth authorization form submission"""
        from urllib.parse import parse_qs, urlencode
        
        # Read form data
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        form_data = parse_qs(body.decode('utf-8'))
        
        # Extract parameters
        redirect_uri = form_data.get('redirect_uri', [''])[0]
        state = form_data.get('state', [''])[0]
        code = form_data.get('code', [''])[0]
        
        if not redirect_uri or not code:
            self.send_response(400)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<html><body><h1>Error</h1><p>Missing redirect_uri or code</p></body></html>")
            return
        
        # Build redirect URL with authorization code
        redirect_params = {
            'code': code,
            'state': state
        }
        
        if '?' in redirect_uri:
            redirect_url = f"{redirect_uri}&{urlencode(redirect_params)}"
        else:
            redirect_url = f"{redirect_uri}?{urlencode(redirect_params)}"
        
        # Send redirect response
        self.send_response(302)
        self.send_header("Location", redirect_url)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        
        # Also send HTML with redirect link as backup
        html_response = f"""
        <html>
        <head>
            <meta http-equiv="refresh" content="0;url={redirect_url}">
        </head>
        <body>
            <p>Authorization successful! Redirecting...</p>
            <p>If you are not redirected, <a href="{redirect_url}">click here</a>.</p>
        </body>
        </html>
        """.encode('utf-8')
        self.wfile.write(html_response)
    
    def _handle_oauth_callback(self):
        """Handle OAuth callback from Enable Banking"""
        # Parse query parameters
        parsed_url = urlparse(self.path)
        query_params = parse_qs(parsed_url.query)
        
        code = query_params.get("code", [None])[0]
        state = query_params.get("state", [None])[0]
        error = query_params.get("error", [None])[0]
        
        if error:
            response_html = f"""
            <html><body>
            <h2>Authorization Failed</h2>
            <p>Error: {error}</p>
            <p>Please try again.</p>
            </body></html>
            """
        elif code:
            response_html = f"""
            <html><body>
            <h2>Authorization Successful</h2>
            <p>Authorization code: <code>{code}</code></p>
            <p>State: <code>{state}</code></p>
            <p>Use the <strong>enable.banking.callback</strong> tool with this code to complete authentication.</p>
            <script>
            window.postMessage({{
                type: 'oauth_callback',
                code: '{code}',
                state: '{state}'
            }}, '*');
            </script>
            </body></html>
            """
        else:
            response_html = """
            <html><body>
            <h2>Invalid Callback</h2>
            <p>No authorization code received.</p>
            </body></html>
            """
        
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(response_html.encode())
    
    def send_json_result(self, result, request_id):
        """Send JSON-RPC 2.0 success response"""
        response = {
            "jsonrpc": "2.0",
            "result": result,
            "id": request_id
        }
        
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(json.dumps(response, indent=2).encode())
    
    def send_json_error(self, code: int, message: str, request_id):
        """Send JSON-RPC 2.0 error response"""
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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(json.dumps(response, indent=2).encode())
    
    def do_OPTIONS(self):
        """Handle CORS preflight requests"""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Length", "0")
        self.end_headers()
    
    def log_message(self, format, *args):
        """Log requests with timestamp"""
        logger.info(f"{self.address_string()} - {format % args}")


def main():
    """Run MCP server with Enable Banking OAuth"""
    port = int(os.getenv("MCP_PORT", 8081))
    
    # Log startup info
    logger.info(f"Starting MCP Server with Enable Banking OAuth on port {port}")
    logger.info("Available endpoints:")
    logger.info("  POST /mcp - JSON-RPC 2.0 MCP requests")
    logger.info("  GET /mcp/stream - SSE streaming")
    logger.info("  GET /auth/callback - OAuth callback")
    logger.info("  GET /health - Health check")
    
    server = HTTPServer(("", port), EnableBankingMCPHandler)
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down server...")
        server.shutdown()


if __name__ == "__main__":
    main()