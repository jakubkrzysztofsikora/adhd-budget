#!/usr/bin/env python3
"""
Integration tests for OAuth 2.0 with PKCE support
Tests T4 Gate: MCP OAuth compliance for Claude Desktop
"""

import os
import pytest
import requests
import json
import hashlib
import base64
import secrets
from urllib.parse import urlencode, parse_qs, urlparse

from src.mcp_remote_server import DEFAULT_REMOTE_REDIRECT_URIS


class TestOAuthPKCE:
    """Test OAuth 2.0 implementation with PKCE for Claude Desktop compatibility"""

    def _base_url(self) -> str:
        """Resolve the base URL for the OAuth server under test."""

        return os.getenv("MCP_URL") or os.getenv("TEST_BASE_URL", "http://localhost:8081")
    
    @pytest.fixture
    def pkce_challenge(self):
        """Generate PKCE code verifier and challenge"""
        # Generate code verifier (43-128 characters)
        verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode('utf-8').rstrip('=')
        
        # Generate code challenge using S256 method
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode('utf-8')).digest()
        ).decode('utf-8').rstrip('=')
        
        return {
            'verifier': verifier,
            'challenge': challenge,
            'method': 'S256'
        }
    
    def test_oauth_discovery(self):
        """Test OAuth 2.0 Authorization Server Metadata discovery"""
        base_url = self._base_url()
        response = requests.get(f"{base_url}/.well-known/oauth-authorization-server")
        
        assert response.status_code == 200
        data = response.json()
        
        # Required fields per RFC 8414
        assert 'issuer' in data
        assert 'authorization_endpoint' in data
        assert 'token_endpoint' in data
        assert 'response_types_supported' in data
        assert 'grant_types_supported' in data
        
        # PKCE support
        assert 'code_challenge_methods_supported' in data
        assert 'S256' in data['code_challenge_methods_supported']
        
        # Refresh token support
        assert 'refresh_token' in data['grant_types_supported']
        
        # Revocation endpoint
        assert 'revocation_endpoint' in data
    
    def test_client_registration(self):
        """Test OAuth 2.0 Dynamic Client Registration (RFC 7591)"""
        # Claude Desktop uses dynamic registration
        registration_data = {
            "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
            "application_type": "native",
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"]
        }
        
        base_url = self._base_url()

        response = requests.post(
            f"{base_url}/oauth/register",
            json=registration_data
        )
        
        assert response.status_code == 201  # RFC 7591 specifies 201 Created for successful registration
        data = response.json()
        
        # Required fields per RFC 7591
        assert 'client_id' in data
        assert 'client_id_issued_at' in data
        assert registration_data['redirect_uris'][0] in data['redirect_uris']
        for remote_uri in DEFAULT_REMOTE_REDIRECT_URIS:
            assert remote_uri in data['redirect_uris']
        assert data['token_endpoint_auth_method'] == 'none'
    
    def test_authorization_with_pkce(self, pkce_challenge):
        """Test authorization endpoint with PKCE parameters"""
        # Build authorization URL with PKCE
        auth_params = {
            'response_type': 'code',
            'client_id': 'test-client',
            'redirect_uri': 'https://claude.ai/api/mcp/auth_callback',
            'scope': 'accounts transactions',
            'state': 'test-state-123',
            'code_challenge': pkce_challenge['challenge'],
            'code_challenge_method': pkce_challenge['method']
        }

        base_url = self._base_url()

        response = requests.get(
            f"{base_url}/oauth/authorize",
            params=auth_params,
            allow_redirects=False
        )

        # Should auto-register allowed remote clients (Claude, ChatGPT) and redirect
        assert response.status_code == 302
        assert response.headers['Location'].startswith('https://claude.ai/api/mcp/auth_callback')
        assert 'code=' in response.headers['Location']
        assert 'state=test-state-123' in response.headers['Location']

    def test_registered_client_receives_redirect(self, pkce_challenge):
        """Registered clients should receive a 302 redirect to their callback."""
        base_url = self._base_url()
        registration_data = {
            "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
            "token_endpoint_auth_method": "none",
        }
        register = requests.post(f"{base_url}/oauth/register", json=registration_data)
        assert register.status_code == 201
        client_id = register.json()["client_id"]

        auth_response = requests.get(
            f"{base_url}/oauth/authorize",
            params={
                'response_type': 'code',
                'client_id': client_id,
                'redirect_uri': 'https://claude.ai/api/mcp/auth_callback',
                'scope': 'accounts transactions',
                'code_challenge': pkce_challenge['challenge'],
                'code_challenge_method': pkce_challenge['method'],
            },
            allow_redirects=False,
        )

        assert auth_response.status_code == 302
        assert auth_response.headers['Location'].startswith('https://claude.ai/api/mcp/auth_callback')

    def test_token_exchange_with_pkce(self, pkce_challenge):
        """Test token endpoint with PKCE code verifier"""
        # Simulate authorization code (in real flow, this comes from callback)
        mock_code = 'eb_session_test_123'
        
        token_data = {
            'grant_type': 'authorization_code',
            'code': mock_code,
            'redirect_uri': 'https://claude.ai/api/mcp/auth_callback',
            'code_verifier': pkce_challenge['verifier']
        }
        
        base_url = self._base_url()

        response = requests.post(
            f"{base_url}/oauth/token",
            data=token_data
        )
        
        assert response.status_code == 200
        data = response.json()
        
        # Required OAuth 2.0 token response fields
        assert 'access_token' in data
        assert 'token_type' in data
        assert data['token_type'] == 'Bearer'
        assert 'expires_in' in data
        
        # Refresh token support for Claude Desktop
        assert 'refresh_token' in data
        assert 'scope' in data
    
    def test_refresh_token(self):
        """Test refresh token grant type"""
        # Use a mock refresh token
        refresh_data = {
            'grant_type': 'refresh_token',
            'refresh_token': 'eb_session_test_refresh_123'
        }
        
        base_url = self._base_url()

        response = requests.post(
            f"{base_url}/oauth/token",
            data=refresh_data
        )
        
        assert response.status_code == 200
        data = response.json()
        
        # Should return new tokens
        assert 'access_token' in data
        assert 'refresh_token' in data
        assert 'expires_in' in data
    
    def test_token_revocation(self):
        """Test token revocation endpoint (RFC 7009)"""
        revoke_data = {
            'token': 'eb_session_test_revoke_123',
            'token_type_hint': 'access_token'
        }
        
        base_url = self._base_url()

        response = requests.post(
            f"{base_url}/oauth/revoke",
            data=revoke_data
        )
        
        # Per RFC 7009, should return 200 OK
        assert response.status_code == 200
    
    def test_protected_resource_metadata(self):
        """Test OAuth 2.0 Protected Resource Metadata discovery"""
        base_url = self._base_url()
        response = requests.get(f"{base_url}/.well-known/oauth-protected-resource")

        assert response.status_code == 200
        data = response.json()

        # Required fields
        assert 'resource' in data
        assert 'authorization_server' in data
        assert data['resource'].endswith('/mcp')

    def test_manifest_discovery(self):
        """Remote clients should discover metadata via /.well-known/mcp.json."""
        base_url = self._base_url()
        headers = {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "mcp.example.com",
        }
        response = requests.get(f"{base_url}/.well-known/mcp.json", headers=headers)

        assert response.status_code == 200
        data = response.json()

        assert data['transport']['endpoint'] == 'https://mcp.example.com/mcp'
        assert 'authorization' in data
        assert 'protocolVersions' in data

        oauth_meta = requests.get(
            f"{base_url}/.well-known/oauth-authorization-server",
            headers=headers,
        ).json()
        assert oauth_meta['issuer'] == 'https://mcp.example.com'
        assert oauth_meta['authorization_endpoint'].startswith('https://mcp.example.com/')

        protected_meta = requests.get(
            f"{base_url}/.well-known/oauth-protected-resource",
            headers=headers,
        ).json()
        assert protected_meta['protectedResourceMetadata']['resource'] == 'https://mcp.example.com/mcp'

    def test_mcp_with_oauth_token(self):
        """Test MCP endpoint accepts OAuth Bearer token"""
        # Use a mock Enable Banking session as token
        mock_token = 'eb_session_test_mcp_123'
        
        # Test tools/list with Bearer token
        mcp_request = {
            "jsonrpc": "2.0",
            "method": "tools/list",
            "params": {},
            "id": 1
        }
        
        base_url = self._base_url()

        response = requests.post(
            f"{base_url}/mcp",
            json=mcp_request,
            headers={'Authorization': f'Bearer {mock_token}'}
        )
        
        assert response.status_code == 200
        data = response.json()
        
        # Should return tools list
        assert 'result' in data
        assert 'tools' in data['result']
        
        # Should have financial tools that require auth
        tool_names = [tool['name'] for tool in data['result']['tools']]
        assert 'summary.today' in tool_names
        assert 'projection.month' in tool_names
    
    def test_claude_desktop_flow(self, pkce_challenge):
        """Test complete OAuth flow as Claude Desktop would do it"""
        base_url = self._base_url()

        # Step 1: Dynamic client registration
        reg_response = requests.post(
            f"{base_url}/oauth/register",
            json={
                "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
                "application_type": "native",
                "token_endpoint_auth_method": "none"
            }
        )
        assert reg_response.status_code == 201  # RFC 7591 specifies 201 Created
        client_id = reg_response.json()['client_id']
        
        # Step 2: Authorization request with PKCE
        auth_params = {
            'response_type': 'code',
            'client_id': client_id,
            'redirect_uri': 'https://claude.ai/api/mcp/auth_callback',
            'scope': 'accounts transactions',
            'state': 'claude-state-456',
            'code_challenge': pkce_challenge['challenge'],
            'code_challenge_method': 'S256'
        }

        auth_response = requests.get(
            f"{base_url}/oauth/authorize",
            params=auth_params,
            allow_redirects=False
        )
        
        assert auth_response.status_code == 302
        assert auth_response.headers['Location'].startswith('https://claude.ai/api/mcp/auth_callback')
        
        # Step 3: Token exchange with PKCE verifier
        # (In real flow, code comes from callback after bank auth)
        mock_code = 'eb_session_claude_789'

        token_response = requests.post(
            f"{base_url}/oauth/token",
            data={
                'grant_type': 'authorization_code',
                'code': mock_code,
                'redirect_uri': 'https://claude.ai/api/mcp/auth_callback',
                'code_verifier': pkce_challenge['verifier'],
                'client_id': client_id
            }
        )
        
        assert token_response.status_code == 200
        token_data = token_response.json()
        access_token = token_data['access_token']

        # Step 4: Use token to access MCP
        mcp_response = requests.post(
            f"{base_url}/mcp",
            json={
                "jsonrpc": "2.0",
                "method": "tools/list",
                "params": {},
                "id": 1
            },
            headers={'Authorization': f'Bearer {access_token}'}
        )
        
        assert mcp_response.status_code == 200
        assert 'tools' in mcp_response.json()['result']

    def test_chatgpt_redirect_is_allowed(self):
        """ChatGPT uses a different redirect URI that should be accepted automatically."""
        base_url = self._base_url()

        # Force-create a sandbox client using the fallback path (no pre-registration)
        token_response = requests.post(
            f"{base_url}/oauth/token",
            data={
                'grant_type': 'authorization_code',
                'code': 'eb_chatgpt_test_code',
                'client_id': 'chatgpt-test-client',
                'redirect_uri': 'https://claude.ai/api/mcp/auth_callback',
            },
        )

        assert token_response.status_code == 200

        # Now hit authorize with ChatGPT's callback URI and ensure we get redirected
        auth_response = requests.get(
            f"{base_url}/oauth/authorize",
            params={
                'response_type': 'code',
                'client_id': 'chatgpt-test-client',
                'redirect_uri': 'https://chat.openai.com/aip/api/auth/callback',
            },
            allow_redirects=False,
        )

        assert auth_response.status_code == 302
        assert auth_response.headers['Location'].startswith('https://chat.openai.com/')


if __name__ == "__main__":
    pytest.main([__file__, "-v"])