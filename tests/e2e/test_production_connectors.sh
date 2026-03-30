#!/bin/bash
# Verify production MCP server is compatible with ChatGPT and Claude.ai
set -euo pipefail

BASE_URL="${1:-https://adhdbudget.bieda.it}"
PASS=0
FAIL=0

check() {
    local name="$1"
    local result="$2"
    if [ "$result" = "true" ] || [ "$result" = "ok" ]; then
        echo "  PASS: $name"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $name (got: $result)"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== MCP Production Connector Verification ==="
echo "Target: $BASE_URL"
echo ""

# 1. OAuth Authorization Server Metadata
echo "--- OAuth Discovery ---"
AS_META=$(curl -sf "$BASE_URL/.well-known/oauth-authorization-server" || echo '{}')
check "registration_endpoint present" "$(echo "$AS_META" | python3 -c 'import sys,json; print("true" if json.load(sys.stdin).get("registration_endpoint") else "false")')"
check "PKCE S256 supported" "$(echo "$AS_META" | python3 -c 'import sys,json; print("true" if "S256" in json.load(sys.stdin).get("code_challenge_methods_supported",[]) else "false")')"
check "token_endpoint_auth none supported" "$(echo "$AS_META" | python3 -c 'import sys,json; print("true" if "none" in json.load(sys.stdin).get("token_endpoint_auth_methods_supported",[]) else "false")')"
echo ""

# 2. Protected Resource Metadata
echo "--- Protected Resource Metadata ---"
PR_META=$(curl -sf "$BASE_URL/.well-known/oauth-protected-resource" || echo '{}')
check "resource field present" "$(echo "$PR_META" | python3 -c 'import sys,json; print("true" if json.load(sys.stdin).get("resource") else "false")')"
check "authorization_servers present" "$(echo "$PR_META" | python3 -c 'import sys,json; print("true" if json.load(sys.stdin).get("authorization_servers") else "false")')"
echo ""

# 3. Client Registration (public client - ChatGPT style)
echo "--- Client Registration (public client) ---"
CLIENT=$(curl -sf -X POST "$BASE_URL/oauth/register" \
    -H "Content-Type: application/json" \
    -d '{"redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],"token_endpoint_auth_method":"none"}' || echo '{}')
check "client_id returned" "$(echo "$CLIENT" | python3 -c 'import sys,json; print("true" if json.load(sys.stdin).get("client_id") else "false")')"
check "auth_method=none preserved" "$(echo "$CLIENT" | python3 -c 'import sys,json; print("true" if json.load(sys.stdin).get("token_endpoint_auth_method")=="none" else "false")')"
check "chatgpt redirect included" "$(echo "$CLIENT" | python3 -c 'import sys,json; uris=json.load(sys.stdin).get("redirect_uris",[]); print("true" if "https://chatgpt.com/connector_platform_oauth_redirect" in uris else "false")')"
check "claude redirect included" "$(echo "$CLIENT" | python3 -c 'import sys,json; uris=json.load(sys.stdin).get("redirect_uris",[]); print("true" if "https://claude.ai/api/mcp/auth_callback" in uris else "false")')"
echo ""

# 4. 401 with WWW-Authenticate
echo "--- 401 + WWW-Authenticate Header ---"
RESP_HEADERS=$(curl -si -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "MCP-Protocol-Version: 2025-06-18" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"summary.today","arguments":{}},"id":"test"}' 2>/dev/null | head -20)
check "401 status returned" "$(echo "$RESP_HEADERS" | grep -q '401' && echo 'true' || echo 'false')"
check "WWW-Authenticate has resource_metadata" "$(echo "$RESP_HEADERS" | grep -qi 'www-authenticate.*resource_metadata' && echo 'true' || echo 'false')"
echo ""

# 5. MCP endpoint returns valid JSON-RPC for tools/list (no auth required per spec)
echo "--- MCP tools/list (unauthenticated) ---"
TOOLS_RESP=$(curl -sf -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "MCP-Protocol-Version: 2025-06-18" \
    -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":"tl"}' || echo '{}')
check "tools/list returns tools" "$(echo "$TOOLS_RESP" | python3 -c 'import sys,json; tools=json.load(sys.stdin).get("result",{}).get("tools",[]); print("true" if len(tools)>0 else "false")')"
check "summary.today tool present" "$(echo "$TOOLS_RESP" | python3 -c 'import sys,json; names=[t["name"] for t in json.load(sys.stdin).get("result",{}).get("tools",[])]; print("true" if "summary.today" in names else "false")')"
echo ""

# Summary
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"
echo ""

if [ "$FAIL" -gt 0 ]; then
    echo "SOME CHECKS FAILED - review output above"
    exit 1
else
    echo "ALL CHECKS PASSED"
    exit 0
fi
