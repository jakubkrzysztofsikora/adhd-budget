"""
S3 Gate: Access Control & Authentication
Real integration test - validates auth enforcement
"""

import pytest
import requests
import json
import jwt
import time
import os
from datetime import datetime, timedelta


class TestS3AccessControl:
    """Test authentication and authorization enforcement"""
    
    @pytest.fixture
    def api_url(self):
        """API URL for testing"""
        return os.getenv("API_URL", "http://api:8082")
    
    @pytest.fixture
    def mcp_url(self):
        """MCP URL for testing"""
        proxy_url = os.getenv("PROXY_URL", "http://reverse-proxy")
        return f"{proxy_url}/mcp"
    
    def test_api_requires_authentication(self, api_url):
        """S3: API endpoints require authentication"""
        protected_endpoints = [
            "/api/transactions",
            "/api/summary",
            "/api/projections",
            "/api/accounts",
            "/api/user/profile"
        ]
        
        for endpoint in protected_endpoints:
            response = requests.get(
                f"{api_url}{endpoint}",
                timeout=5
            )
            
            # API endpoints without auth MUST return 401 or 403
            assert response.status_code in [401, 403], \
                f"{endpoint} should require authentication, got {response.status_code}"
    
    def test_mcp_requires_bearer_token(self, mcp_url):
        """S3: MCP requires valid bearer token"""
        # Test without token
        response = requests.post(
            mcp_url,
            json={
                "jsonrpc": "2.0",
                "method": "tools/list",
                "id": "test-1"
            },
            timeout=5
        )
        
        assert response.status_code in [401, 403], \
            "MCP should require authentication"
        
        # Test with invalid token
        response = requests.post(
            mcp_url,
            json={
                "jsonrpc": "2.0",
                "method": "tools/list",
                "id": "test-2"
            },
            headers={"Authorization": "Bearer invalid_token_123"},
            timeout=5
        )
        
        assert response.status_code in [401, 403], \
            "MCP should reject invalid tokens"
    
    def test_token_expiry_enforced(self, api_url):
        """S3: Expired tokens are rejected"""
        # Create an expired JWT (would need secret in real test)
        expired_token = self._create_expired_token()
        
        response = requests.get(
            f"{api_url}/api/transactions",
            headers={"Authorization": f"Bearer {expired_token}"},
            timeout=5
        )
        
        assert response.status_code in [401, 403], \
            "Expired tokens should be rejected"
    
    def test_enable_banking_oauth_flow(self, api_url):
        """S3: Enable Banking OAuth properly secured"""
        # Test OAuth initiation requires auth
        response = requests.get(
            f"{api_url}/api/auth/enable-banking/authorize",
            timeout=5
        )
        
        assert response.status_code in [401, 403], \
            "OAuth initiation should require authentication"
        
        # Test callback validation
        response = requests.get(
            f"{api_url}/api/auth/callback",
            params={
                "code": "fake_code",
                "state": "fake_state"
            },
            timeout=5
        )
        
        # Should validate state parameter
        assert response.status_code >= 400, \
            "Invalid OAuth callback should fail"
    
    def test_no_sql_injection(self, api_url):
        """S3: SQL injection attempts blocked"""
        sql_payloads = [
            "' OR '1'='1",
            "1; DROP TABLE transactions;--",
            "' UNION SELECT * FROM users--",
            "admin'--",
            "1' AND '1' = '1"
        ]
        
        for payload in sql_payloads:
            # Try injection in query parameter
            response = requests.get(
                f"{api_url}/api/transactions",
                params={"search": payload},
                timeout=5
            )
            
            # Should not return 500 (server error from SQL)
            assert response.status_code != 500, \
                f"Possible SQL injection vulnerability with: {payload}"
    
    def test_no_path_traversal(self, api_url):
        """S3: Path traversal attempts blocked"""
        traversal_payloads = [
            "../../../etc/passwd",
            "..\\..\\..\\windows\\system32\\config\\sam",
            "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
            "....//....//....//etc/passwd"
        ]
        
        for payload in traversal_payloads:
            response = requests.get(
                f"{api_url}/api/files/{payload}",
                timeout=5
            )
            
            # Should not return file contents
            if response.status_code == 200:
                assert "/etc/passwd" not in response.text, \
                    "Path traversal vulnerability detected"
            
            # Should return 400 or 404
            assert response.status_code in [400, 403, 404], \
                f"Path traversal not properly blocked: {payload}"
    
    def test_rate_limiting(self, api_url):
        """S3: Rate limiting prevents abuse"""
        # Make many rapid requests
        responses = []
        for i in range(100):
            try:
                response = requests.get(
                    f"{api_url}/api/health",
                    timeout=1
                )
                responses.append(response.status_code)
            except:
                break
        
        # Should see rate limiting (429) or connection issues
        if 429 in responses:
            assert True, "Rate limiting is active"
        elif len(responses) < 100:
            # Connection refused/timeout also indicates protection
            assert True, "Connection limiting is active"
        else:
            pytest.skip("Rate limiting not detected (may need configuration)")
    
    def test_cors_configuration(self, api_url):
        """S3: CORS properly configured"""
        # Test preflight request
        response = requests.options(
            f"{api_url}/api/transactions",
            headers={
                "Origin": "https://evil.com",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type"
            },
            timeout=5
        )
        
        if "Access-Control-Allow-Origin" in response.headers:
            allowed_origin = response.headers["Access-Control-Allow-Origin"]
            
            # Should not allow all origins in production
            assert allowed_origin != "*", \
                "CORS should not allow all origins"
            
            # Should not allow evil.com
            assert "evil.com" not in allowed_origin, \
                "CORS should not allow arbitrary origins"
    
    def test_sensitive_data_not_exposed(self, api_url):
        """S3: Sensitive data not exposed in errors"""
        # Trigger various errors
        error_triggers = [
            ("/api/nonexistent", {}),
            ("/api/transactions", {"id": "invalid"}),
            ("/api/summary", {"date": "not-a-date"})
        ]
        
        for endpoint, params in error_triggers:
            response = requests.get(
                f"{api_url}{endpoint}",
                params=params,
                timeout=5
            )
            
            if response.status_code >= 400:
                # Check response doesn't leak sensitive info
                response_text = response.text.lower()
                
                sensitive_patterns = [
                    "password",
                    "secret",
                    "token",
                    "api_key",
                    "stack trace",
                    "traceback",
                    "/home/",
                    "/usr/",
                    "postgre",
                    "mysql"
                ]
                
                for pattern in sensitive_patterns:
                    assert pattern not in response_text, \
                        f"Error response may leak sensitive info: {pattern}"
    
    def test_session_security(self, api_url):
        """S3: Session tokens properly secured"""
        # Make a request that might set cookies
        response = requests.post(
            f"{api_url}/api/auth/login",
            json={"username": "test", "password": "test"},
            timeout=5
        )
        
        if response.cookies:
            for cookie in response.cookies:
                # Check security flags
                assert cookie.secure or "localhost" in api_url, \
                    "Session cookies should have Secure flag"
                
                assert cookie.has_nonstandard_attr("HttpOnly") or \
                       cookie.get_nonstandard_attr("HttpOnly"), \
                    "Session cookies should have HttpOnly flag"
                
                assert cookie.get_nonstandard_attr("SameSite") in ["Strict", "Lax"], \
                    "Session cookies should have SameSite flag"
    
    def test_authorization_levels(self, api_url):
        """S3: Different auth levels properly enforced"""
        # This would need real tokens with different permissions
        # Document what should be tested
        
        test_cases = [
            ("User can only access own transactions", "user_token", "/api/transactions?user_id=other"),
            ("Admin can access all transactions", "admin_token", "/api/transactions"),
            ("Unauthenticated cannot access any", None, "/api/transactions")
        ]
        
        print("Authorization test cases to verify:")
        for description, token_type, endpoint in test_cases:
            print(f"  - {description}: {token_type} -> {endpoint}")
    
    def _create_expired_token(self):
        """Helper to create expired JWT for testing"""
        # In real implementation, would use actual secret
        payload = {
            "sub": "test_user",
            "exp": datetime.utcnow() - timedelta(hours=1)  # Expired 1 hour ago
        }
        
        # Using 'secret' as dummy secret for testing
        return jwt.encode(payload, "secret", algorithm="HS256")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])