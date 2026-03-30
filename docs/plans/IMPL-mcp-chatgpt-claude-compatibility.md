# MCP ChatGPT + Claude.ai Compatibility & Local E2E Testing

**Created**: 2026-02-15
**Status**: In Progress

## Overview

Fix remaining gaps in the MCP server OAuth/protocol implementation to achieve working integration with both ChatGPT connectors and Claude.ai integrations, then add automated local E2E testing using Playwright MCP to verify the full OAuth flow without manual browser testing.

## Current State Analysis

The MCP server at `src/mcp_fastapi_server.py` is ~95% ready. Backend protocol tests pass. However, real-world integration with ChatGPT and Claude.ai fails due to subtle OAuth flow issues and missing configuration details.

### Key Discoveries:

- **WWW-Authenticate header never reaches Claude.ai**: `_handle_mcp_post` catches `HTTPException` at line 1071 before the FastAPI exception handler (line 629) can add the `WWW-Authenticate` header. Claude.ai needs this header to discover the authorization server when it gets a 401 on tool calls.
- **Missing redirect URIs**: ChatGPT uses `https://chatgpt.com/oauth/callback` and `https://chat.openai.com/oauth/callback` which are absent from `DEFAULT_REMOTE_REDIRECT_URIS` (lines 91-112).
- **Missing `claude.com/` prefix**: `REMOTE_REDIRECT_PREFIXES` (lines 114-123) doesn't include `https://claude.com/` even though `https://claude.com/api/mcp/auth_callback` is in the URI list.
- **Caddyfile.test missing headers**: `.well-known*`, `/oauth*`, and `/mcp*` routes don't forward `X-Forwarded-Host`, causing `_external_base_url()` to return internal Docker hostnames like `mcp-server:8081` instead of `localhost`.
- **ChatGPT public client issue**: ChatGPT registers with `token_endpoint_auth_method: "none"`. The metadata endpoint (line 712) already includes `"none"` in `token_endpoint_auth_methods_supported` - good.
- **No automated browser testing**: OAuth flow testing requires manual browser clicks. Playwright MCP can automate this.

## Desired End State

1. ChatGPT connector flow works end-to-end: add server URL → OAuth completes → tools are invocable
2. Claude.ai integration flow works end-to-end: add connector → OAuth completes → tools are invocable
3. Local `make test-e2e-browser` runs a Playwright MCP-based script that exercises the full OAuth flow against the local Docker stack and verifies tool invocation
4. All existing tests continue to pass

### How to verify:
- `pytest tests/integration/ -v` all pass
- `pytest tests/unit/ -v` all pass
- Playwright-based E2E test completes successfully against local Docker stack
- Manual verification: add `https://adhdbudget.bieda.it/mcp` in ChatGPT Developer Mode → tools appear and respond
- Manual verification: add `https://adhdbudget.bieda.it/mcp` in Claude.ai integrations → tools appear and respond

## What We're NOT Doing

- Not implementing MCP spec 2025-11-25 (CIMD, step-up auth) — ChatGPT/Claude still use 2025-06-18 in practice
- Not fixing the known Claude.ai December 2025 OAuth breakage (Anthropic-side issue)
- Not implementing persistent OAuth token storage (in-memory is fine for MVP+1)
- Not adding a full Keycloak/external OAuth provider
- Not testing with real Enable Banking credentials (mock mode is sufficient for flow verification)

## Implementation Approach

Four focused phases: fix server gaps, fix proxy headers, add browser E2E testing, then verify.

---

## Phase 1: Fix MCP Server OAuth/Protocol Gaps

### Overview
Fix the specific issues that prevent ChatGPT and Claude.ai from completing the OAuth flow and invoking tools.

### Changes Required:

#### 1. Add WWW-Authenticate header to JSON-RPC 401 responses
**File**: `src/mcp_fastapi_server.py`
**Problem**: The try/except at line 1071 catches `HTTPException` and converts it to a JSON-RPC error via `_jsonrpc_error()`, bypassing the exception handler that adds `WWW-Authenticate`.
**Fix**: Modify `_jsonrpc_error` to accept and pass through headers, and explicitly add `WWW-Authenticate` when status is 401.

```python
# In _jsonrpc_error method (line 1201), add headers parameter:
def _jsonrpc_error(self, request_id: Any, code: int, message: str, *, status: int = 200, headers: Optional[Dict[str, str]] = None) -> JSONResponse:
    return JSONResponse(
        content={"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}},
        status_code=status,
        headers=headers,
    )

# In the except HTTPException block (line 1071-1072), add WWW-Authenticate:
except HTTPException as exc:
    headers = None
    if exc.status_code == 401:
        base_url = _external_base_url(request)
        headers = {"WWW-Authenticate": f'Bearer resource_metadata="{base_url}/.well-known/oauth-protected-resource"'}
    return self._jsonrpc_error(request_id, -32000, exc.detail, status=exc.status_code, headers=headers)
```

#### 2. Add missing ChatGPT redirect URIs
**File**: `src/mcp_fastapi_server.py`
**Changes**: Add the two confirmed ChatGPT callback URLs to `DEFAULT_REMOTE_REDIRECT_URIS`:

```python
# Add after line 101 (the chatgpt.com connector_platform entries):
"https://chatgpt.com/oauth/callback",
"https://chat.openai.com/oauth/callback",
```

#### 3. Add `claude.com` to REMOTE_REDIRECT_PREFIXES
**File**: `src/mcp_fastapi_server.py`
**Changes**: Add prefix for the `claude.com` domain:

```python
# Add after the claude.ai entries in REMOTE_REDIRECT_PREFIXES:
"https://claude.com/",
"https://www.claude.com/",
```

#### 4. Add `platform.openai.com` to REMOTE_REDIRECT_PREFIXES
**File**: `src/mcp_fastapi_server.py`
**Changes**: The URI `https://platform.openai.com/apps-manage/oauth` is in DEFAULT_REMOTE_REDIRECT_URIS but the prefix isn't checked:

```python
# Add to REMOTE_REDIRECT_PREFIXES:
"https://platform.openai.com/",
```

#### 5. Ensure tools/list works without auth (per MCP spec)
**File**: `src/mcp_fastapi_server.py`
**Status**: Already working — `tools/list` at line 1058 calls `_handle_tools_list` which doesn't check auth. No change needed.

#### 6. Ensure initialize response includes protectedResourceMetadata
**File**: `src/mcp_fastapi_server.py`
**Status**: Already present at line 1141-1144. No change needed.

### Success Criteria:

#### Automated Verification:
- [x] `pytest tests/unit/ -v` passes (35/40 pass, 5 pre-existing async failures)
- [ ] `pytest tests/integration/ -v` passes
- [x] curl test: POST /mcp with tools/call (no auth) returns 401 with `WWW-Authenticate` header containing `resource_metadata`
- [x] curl test: POST /oauth/register with `token_endpoint_auth_method: "none"` returns 201 with the field preserved

#### Manual Verification:
- [ ] Confirm JSON-RPC 401 response includes `WWW-Authenticate` header by inspecting raw HTTP response

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Fix Caddyfile Forwarding Headers

### Overview
Fix the test Caddyfile so that `_external_base_url()` returns the correct externally-visible URL during local development and testing.

### Changes Required:

#### 1. Update Caddyfile.test with proper forwarding headers
**File**: `Caddyfile.test`
**Changes**: Add `X-Forwarded-Host` to `.well-known*`, `/oauth*`, and `/auth*` routes. Add both `X-Forwarded-Proto` and `X-Forwarded-Host` to `/mcp*` route.

```caddy
# MCP Server with SSE support
handle /mcp* {
    reverse_proxy mcp-server:8081 {
        # Disable buffering for SSE
        flush_interval -1

        # Headers for SSE
        header_up Accept-Encoding identity
        header_down Cache-Control no-cache
        header_down X-Accel-Buffering no

        # Forwarding headers for URL generation
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }
}

# OAuth endpoints (well-known, token, callback)
handle /.well-known* {
    reverse_proxy mcp-server:8081 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }
}

handle /oauth* {
    reverse_proxy mcp-server:8081 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }
}

handle /auth* {
    reverse_proxy mcp-server:8081 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }
}
```

### Success Criteria:

#### Automated Verification:
- [ ] `DB_PASSWORD=testdupa123! docker compose up -d` succeeds with Caddyfile.test
- [ ] `curl -s http://localhost/.well-known/mcp.json | jq '.transport.endpoint'` returns URL with `localhost` (not `mcp-server:8081`)
- [ ] `curl -s http://localhost/.well-known/oauth-authorization-server | jq '.issuer'` returns URL with `localhost`

#### Manual Verification (requires Docker):
- [ ] All services start and healthchecks pass

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 3: Add Playwright MCP for Local E2E OAuth Testing

### Overview
Create a Playwright-based E2E test that exercises the complete OAuth flow locally against the Docker stack, automating what was previously manual browser testing.

### Changes Required:

#### 1. Create E2E test script using Playwright
**File**: `tests/e2e/test_oauth_browser_flow.py`
**Purpose**: Automated browser-based test of the complete OAuth flow

This test will:
1. Start with a registered OAuth client (via HTTP request to /oauth/register)
2. Generate PKCE code_verifier and code_challenge
3. Use Playwright to navigate to the authorize endpoint
4. In mock mode, follow the redirect chain (authorize → mock callback → client redirect)
5. Extract the authorization code from the final redirect URL
6. Exchange the code for tokens via HTTP POST
7. Use the token to call tools/list and tools/call via the MCP endpoint
8. Verify the tool response contains expected data

```python
"""E2E browser-based OAuth flow test using Playwright.

Requires: pip install playwright && playwright install chromium
Runs against local Docker stack with ENABLE_MOCK_FALLBACK=true.
"""
import base64
import hashlib
import json
import secrets
from urllib.parse import parse_qs, urlparse

import pytest
import requests

# Only run if playwright is available
playwright = pytest.importorskip("playwright.sync_api")


@pytest.fixture(scope="module")
def base_url():
    """Base URL for the local Docker stack."""
    import os
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
    assert resp.status_code == 201
    return resp.json()


@pytest.fixture(scope="module")
def pkce_pair():
    """Generate PKCE code verifier and challenge."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).decode().rstrip("=")
    return {"verifier": verifier, "challenge": challenge}


class TestOAuthBrowserFlow:
    """Test complete OAuth flow using Playwright browser automation."""

    def test_full_oauth_flow(self, base_url, registered_client, pkce_pair):
        """Exercise the complete OAuth flow in a real browser."""
        client_id = registered_client["client_id"]
        redirect_uri = "http://localhost:6274/callback"
        state = secrets.token_urlsafe(16)

        # Build authorize URL
        auth_url = (
            f"{base_url}/oauth/authorize"
            f"?client_id={client_id}"
            f"&redirect_uri={redirect_uri}"
            f"&response_type=code"
            f"&scope=transactions+accounts"
            f"&state={state}"
            f"&code_challenge={pkce_pair['challenge']}"
            f"&code_challenge_method=S256"
        )

        # Use Playwright to follow the OAuth redirect chain
        with playwright.sync_api.sync_playwright() as p:
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
            "code_verifier": pkce_pair["verifier"],
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
        assert "resource_metadata" in www_auth
        assert ".well-known/oauth-protected-resource" in www_auth

    def test_token_refresh_flow(self, base_url, registered_client, pkce_pair):
        """Test that refresh tokens work correctly."""
        client_id = registered_client["client_id"]
        redirect_uri = "http://localhost:6274/callback"
        state = secrets.token_urlsafe(16)

        # Get initial tokens via mock OAuth flow (using requests, not browser)
        auth_resp = requests.get(
            f"{base_url}/oauth/authorize",
            params={
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": "transactions accounts",
                "state": state,
                "code_challenge": pkce_pair["challenge"],
                "code_challenge_method": "S256",
            },
            allow_redirects=False,
        )
        assert auth_resp.status_code == 302
        location = auth_resp.headers["Location"]
        parsed = urlparse(location)
        params = parse_qs(parsed.query)
        auth_code = params["code"][0]

        token_resp = requests.post(f"{base_url}/oauth/token", data={
            "grant_type": "authorization_code",
            "code": auth_code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "code_verifier": pkce_pair["verifier"],
        })
        tokens = token_resp.json()

        # Use refresh token to get new access token
        refresh_resp = requests.post(f"{base_url}/oauth/token", data={
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
            "client_id": client_id,
        })
        assert refresh_resp.status_code == 200
        new_tokens = refresh_resp.json()
        assert "access_token" in new_tokens
        assert new_tokens["access_token"] != tokens["access_token"]
```

#### 2. Add Playwright dependency to test requirements
**File**: `Dockerfile.test` (or test requirements)
**Changes**: Add `playwright` to test dependencies

#### 3. Add Makefile target
**File**: `Makefile`
**Changes**: Add `test-e2e-browser` target

```makefile
test-e2e-browser:  ## Run browser-based E2E OAuth flow tests
    $(PYTHON) -m pytest tests/e2e/test_oauth_browser_flow.py -v --tb=short --timeout=120
```

### Success Criteria:

#### Automated Verification:
- [ ] `pytest tests/e2e/test_oauth_browser_flow.py -v` passes against local Docker stack
- [ ] test_full_oauth_flow: Complete OAuth flow (register → authorize → token → tools/list → tools/call)
- [ ] test_401_includes_www_authenticate: 401 response has proper WWW-Authenticate header
- [ ] test_token_refresh_flow: Refresh token returns new valid access token

#### Manual Verification:
- [ ] Run the test in headed mode (`--headed`) and visually confirm the browser navigates correctly

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 4: Production Verification & Connector Testing

### Overview
Deploy to production and verify ChatGPT and Claude.ai connectors work.

### Changes Required:

#### 1. Create a production verification script
**File**: `tests/e2e/test_production_connectors.sh`
**Purpose**: Automated backend verification against production before manual UI testing

```bash
#!/bin/bash
# Verify production MCP server is compatible with ChatGPT and Claude.ai
BASE_URL="https://adhdbudget.bieda.it"

# 1. OAuth discovery
echo "=== OAuth Discovery ==="
curl -s "$BASE_URL/.well-known/oauth-authorization-server" | jq '{
  has_registration: (.registration_endpoint != null),
  has_pkce: (.code_challenge_methods_supported | index("S256") != null),
  supports_none_auth: (.token_endpoint_auth_methods_supported | index("none") != null)
}'

# 2. Protected resource metadata
echo "=== Protected Resource Metadata ==="
curl -s "$BASE_URL/.well-known/oauth-protected-resource" | jq '{
  resource: .resource,
  auth_servers: .authorization_servers
}'

# 3. Client registration with public client
echo "=== Client Registration (public) ==="
CLIENT=$(curl -s -X POST "$BASE_URL/oauth/register" \
  -H "Content-Type: application/json" \
  -d '{"redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],"token_endpoint_auth_method":"none"}')
echo "$CLIENT" | jq '{
  client_id: .client_id,
  auth_method: .token_endpoint_auth_method,
  has_chatgpt_redirect: (.redirect_uris | index("https://chatgpt.com/connector_platform_oauth_redirect") != null),
  has_claude_redirect: (.redirect_uris | index("https://claude.ai/api/mcp/auth_callback") != null)
}'

# 4. 401 with WWW-Authenticate
echo "=== 401 + WWW-Authenticate ==="
RESP=$(curl -si -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"summary.today","arguments":{}},"id":"test"}')
echo "$RESP" | grep -i "www-authenticate"

echo "=== All checks complete ==="
```

### Success Criteria:

#### Automated Verification:
- [ ] Production verification script passes all checks
- [ ] `curl` 401 test shows `WWW-Authenticate: Bearer resource_metadata=...`
- [ ] Client registration includes both ChatGPT and Claude redirect URIs
- [ ] OAuth metadata includes `"none"` in token_endpoint_auth_methods_supported

#### Manual Verification:
- [ ] Add `https://adhdbudget.bieda.it/mcp` in ChatGPT Developer Mode → OAuth completes → tools invokable
- [ ] Add `https://adhdbudget.bieda.it/mcp` in Claude.ai integrations → OAuth completes → tools invokable

**Implementation Note**: After completing this phase, the full implementation is done. Capture screenshots of successful ChatGPT and Claude.ai tool invocations as evidence.

---

## Testing Strategy

### Unit Tests:
- Existing `tests/unit/test_oauth_provider.py` covers PKCE, token exchange, client registration
- No new unit tests needed — gaps are in integration/configuration

### Integration Tests:
- Existing `tests/integration/test_oauth_pkce.py` covers the OAuth PKCE flow
- Existing `tests/integration/test_t4_mcp_streaming.py` covers MCP protocol compliance
- New assertion needed: 401 response includes `WWW-Authenticate` header

### E2E Tests:
- New `tests/e2e/test_oauth_browser_flow.py` — Playwright-based full OAuth flow
- New `tests/e2e/test_production_connectors.sh` — Production readiness check

### Manual Testing Steps:
1. Start local Docker stack: `DB_PASSWORD=testdupa123! docker compose up -d`
2. Run browser test: `pytest tests/e2e/test_oauth_browser_flow.py -v`
3. Deploy to production: push to main
4. Run production check: `./tests/e2e/test_production_connectors.sh`
5. Test in ChatGPT: Settings → Connectors → Developer Mode → Add URL
6. Test in Claude.ai: Settings → Integrations → Add MCP server URL

## Performance Considerations

No performance implications — changes are limited to:
- Adding 4 string entries to redirect URI lists
- Adding one HTTP header to 401 responses
- Adding one parameter to `_jsonrpc_error` method

## Risk Assessment

- **Low risk**: Redirect URI additions are additive (no existing behavior changes)
- **Low risk**: Caddyfile header additions only affect test configuration
- **Medium risk**: WWW-Authenticate header fix changes 401 response format — verify existing clients still work
- **Known limitation**: Claude.ai December 2025 OAuth breakage is an Anthropic-side issue that may still affect some users regardless of our fixes

## References

- MCP Spec 2025-06-18 Authorization: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- RFC 9728 (Protected Resource Metadata): referenced in spec
- RFC 7591 (Dynamic Client Registration): used by both ChatGPT and Claude.ai
- ChatGPT Connectors OAuth: https://platform.openai.com/docs/mcp
- Claude.ai MCP Integrations: https://support.claude.com/en/articles/11503834
- Known Claude OAuth issue: https://github.com/anthropics/claude-ai-mcp/issues/5
- Known ChatGPT 401 re-trigger bug: https://community.openai.com/t/chatgpt-does-not-re-trigger-oauth-on-401
