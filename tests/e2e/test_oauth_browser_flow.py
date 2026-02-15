"""E2E browser-based OAuth flow test using Playwright.

Requires: pip install playwright && playwright install chromium
Runs against local Docker stack with ENABLE_MOCK_FALLBACK=true.
"""
import base64
import hashlib
import json
import os
import secrets
from urllib.parse import parse_qs, urlparse

import pytest
import requests

# Only run if playwright is available
pw_sync = pytest.importorskip("playwright.sync_api")


@pytest.fixture(scope="module")
def base_url():
    """Base URL for the local Docker stack."""
    return os.getenv("TEST_BASE_URL", "http://localhost")


@pytest.fixture(scope="module")
def registered_client(base_url):
    """Register an OAuth client."""
    resp = requests.post(f"{base_url}/oauth/register", json={
        "redirect_uris": ["http://localhost:6274/callback"],
        "client_name": "Playwright E2E Test",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    })
    assert resp.status_code == 201, f"Client registration failed: {resp.text}"
    return resp.json()


def _make_pkce_pair():
    """Generate a fresh PKCE code verifier and challenge."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).decode().rstrip("=")
    return {"verifier": verifier, "challenge": challenge}


def _get_tokens_via_mock_flow(base_url, client_id, redirect_uri, pkce):
    """Complete the OAuth mock flow and return tokens."""
    state = secrets.token_urlsafe(16)
    auth_resp = requests.get(
        f"{base_url}/oauth/authorize",
        params={
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "transactions accounts",
            "state": state,
            "code_challenge": pkce["challenge"],
            "code_challenge_method": "S256",
        },
        allow_redirects=False,
    )
    assert auth_resp.status_code == 302, f"Expected 302, got {auth_resp.status_code}"
    location = auth_resp.headers["Location"]
    parsed = urlparse(location)
    params = parse_qs(parsed.query)
    assert "code" in params, f"No auth code in redirect: {location}"
    assert params.get("state", [None])[0] == state, "State mismatch"

    token_resp = requests.post(f"{base_url}/oauth/token", data={
        "grant_type": "authorization_code",
        "code": params["code"][0],
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "code_verifier": pkce["verifier"],
    })
    assert token_resp.status_code == 200, f"Token exchange failed: {token_resp.text}"
    return token_resp.json()


class TestOAuthBrowserFlow:
    """Test complete OAuth flow using Playwright browser automation."""

    def test_full_oauth_flow(self, base_url, registered_client):
        """Exercise the complete OAuth flow in a real browser."""
        client_id = registered_client["client_id"]
        redirect_uri = "http://localhost:6274/callback"
        state = secrets.token_urlsafe(16)
        pkce = _make_pkce_pair()

        # Build authorize URL
        auth_url = (
            f"{base_url}/oauth/authorize"
            f"?client_id={client_id}"
            f"&redirect_uri={redirect_uri}"
            f"&response_type=code"
            f"&scope=transactions+accounts"
            f"&state={state}"
            f"&code_challenge={pkce['challenge']}"
            f"&code_challenge_method=S256"
        )

        # Use Playwright to follow the OAuth redirect chain
        with pw_sync.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()

            # Navigate to authorize endpoint
            # In mock mode, this immediately redirects to callback with code
            response = page.goto(auth_url, wait_until="networkidle")

            final_url = page.url
            browser.close()

        # Parse the callback URL for the authorization code
        parsed = urlparse(final_url)
        params = parse_qs(parsed.query)

        # The redirect should have landed on the callback with code and state
        assert "code" in params, f"No auth code in redirect URL: {final_url}"
        assert params.get("state", [None])[0] == state, "State mismatch"

        auth_code = params["code"][0]

        # Exchange code for tokens
        token_resp = requests.post(f"{base_url}/oauth/token", data={
            "grant_type": "authorization_code",
            "code": auth_code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "code_verifier": pkce["verifier"],
        })
        assert token_resp.status_code == 200, f"Token exchange failed: {token_resp.text}"
        tokens = token_resp.json()
        assert "access_token" in tokens
        assert "refresh_token" in tokens

        # Use token to call tools/list
        mcp_resp = requests.post(f"{base_url}/mcp", json={
            "jsonrpc": "2.0",
            "method": "tools/list",
            "params": {},
            "id": "e2e-1",
        }, headers={
            "Authorization": f"Bearer {tokens['access_token']}",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": "2025-06-18",
        })
        assert mcp_resp.status_code == 200
        tools = mcp_resp.json().get("result", {}).get("tools", [])
        tool_names = {t["name"] for t in tools}
        assert "summary.today" in tool_names
        assert "accounts.list" in tool_names

        # Use token to call a protected tool
        call_resp = requests.post(f"{base_url}/mcp", json={
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": "echo", "arguments": {"message": "e2e test"}},
            "id": "e2e-2",
        }, headers={
            "Authorization": f"Bearer {tokens['access_token']}",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": "2025-06-18",
        })
        assert call_resp.status_code == 200
        result = call_resp.json().get("result", {})
        assert result.get("content", [{}])[0].get("text") == "e2e test"

    def test_401_includes_www_authenticate(self, base_url):
        """Verify 401 responses include WWW-Authenticate header for OAuth discovery."""
        resp = requests.post(f"{base_url}/mcp", json={
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": "summary.today", "arguments": {}},
            "id": "auth-test",
        }, headers={
            "Content-Type": "application/json",
            "MCP-Protocol-Version": "2025-06-18",
        })
        assert resp.status_code == 401
        www_auth = resp.headers.get("WWW-Authenticate", "")
        assert "resource_metadata" in www_auth, f"Missing resource_metadata in: {www_auth}"
        assert ".well-known/oauth-protected-resource" in www_auth

    def test_token_refresh_flow(self, base_url, registered_client):
        """Test that refresh tokens work correctly."""
        client_id = registered_client["client_id"]
        redirect_uri = "http://localhost:6274/callback"
        pkce = _make_pkce_pair()

        # Get initial tokens via mock OAuth flow
        tokens = _get_tokens_via_mock_flow(base_url, client_id, redirect_uri, pkce)
        assert "refresh_token" in tokens

        # Use refresh token to get new access token
        refresh_resp = requests.post(f"{base_url}/oauth/token", data={
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
            "client_id": client_id,
        })
        assert refresh_resp.status_code == 200, f"Refresh failed: {refresh_resp.text}"
        new_tokens = refresh_resp.json()
        assert "access_token" in new_tokens
        assert new_tokens["access_token"] != tokens["access_token"]
