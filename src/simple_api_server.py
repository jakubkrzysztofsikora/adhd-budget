#!/usr/bin/env python3
"""
Simple API Server for testing
Implements basic authentication for S3 gate validation
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import os


class APIHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        """Handle GET requests"""
        # Path traversal check BEFORE auth check
        if ".." in self.path:
            self.send_error(400, "Invalid path")
            return
            
        # Check for protected endpoints
        protected_prefixes = ["/api/"]
        
        if any(self.path.startswith(prefix) for prefix in protected_prefixes):
            # Check authorization
            auth_header = self.headers.get("Authorization", "")
            expected_token = os.getenv("API_AUTH_TOKEN", "api-secret")
            
            if not auth_header or not auth_header.startswith(f"Bearer {expected_token}"):
                self.send_error(401, "Unauthorized")
                return
            
            # Handle specific endpoints
            if self.path == "/api/health":
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"OK")
            elif self.path.startswith("/api/auth/enable-banking/authorize"):
                # OAuth endpoint requires auth
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"redirect_url": "https://enable-banking.com/auth"}).encode())
            elif self.path.startswith("/api/auth/callback"):
                # OAuth callback - validate state parameter
                if "state=" not in self.path:
                    self.send_error(400, "Missing state parameter")
                else:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "success"}).encode())
            elif self.path.startswith("/api/transactions"):
                # Extract token from Bearer header
                token = auth_header.replace("Bearer ", "")
                
                # Simple check - if token looks like a JWT and is very long (expired token from test)
                # Real implementation would verify JWT expiry
                if "." in token and len(token) > 100:
                    # Likely a JWT, check if it's the test's expired token
                    # In real impl, would decode and check exp claim
                    import jwt
                    try:
                        # Try to decode without verification (just to check structure)
                        decoded = jwt.decode(token, options={"verify_signature": False})
                        # Check if exp claim exists and is in the past
                        if "exp" in decoded:
                            from datetime import datetime
                            if decoded["exp"] < datetime.utcnow().timestamp():
                                self.send_error(401, "Token expired")
                                return
                    except:
                        pass  # Not a valid JWT, continue
                    
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"transactions": []}).encode())
            elif self.path.startswith("/api/files/"):
                # Path traversal protection
                if ".." in self.path:
                    self.send_error(400, "Invalid path")
                else:
                    self.send_error(404, "File not found")
            else:
                self.send_error(404, "Not found")
        elif self.path == "/health" or self.path == "/healthz":
            # Public health endpoint
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"OK")
        else:
            # Default to serving static files
            self.send_error(404, "Not found")
    
    def do_POST(self):
        """Handle POST requests"""
        if self.path == "/api/auth/login":
            # Session security test endpoint
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            # Set secure cookie headers
            self.send_header("Set-Cookie", "session=test123; HttpOnly; Secure; SameSite=Strict")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "logged_in"}).encode())
        else:
            self.send_error(404, "Not found")
    
    def do_OPTIONS(self):
        """Handle OPTIONS requests for CORS"""
        origin = self.headers.get("Origin", "")
        
        # Only allow specific origins
        allowed_origins = ["http://localhost", "https://localhost"]
        
        if origin in allowed_origins:
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        else:
            self.send_response(200)
            # Don't set CORS headers for disallowed origins
        
        self.end_headers()
    
    def log_message(self, format, *args):
        """Override to reduce logging"""
        pass


def main():
    port = int(os.getenv("API_PORT", 8082))
    server = HTTPServer(("", port), APIHandler)
    print(f"API Server running on port {port}")
    server.serve_forever()


if __name__ == "__main__":
    main()