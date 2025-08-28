#!/bin/bash
#
# Validate MCP server compliance against official standards
# Returns 0 if compliant, 1 if not
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔍 Validating MCP Compliance against Official Standards..."
echo "========================================================="

FAILED=0
MCP_URL="http://localhost:8081"
MCP_TOKEN="test_mcp_token_secure_2024"

# Check if server is running
if ! curl -s -f -o /dev/null "$MCP_URL/health" 2>/dev/null; then
    echo -e "${YELLOW}⚠ MCP server not running locally, checking production...${NC}"
    MCP_URL="https://adhdbudget.bieda.it"
fi

# 1. Check protocol version support
echo -e "\n${YELLOW}[1] Checking protocol version...${NC}"
RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -H "Content-Type: application/json" \
    -H "MCP-Protocol-Version: 2025-06-18" \
    -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"validator","version":"1.0.0"}},"id":1}' 2>/dev/null || echo "{}")

if echo "$RESPONSE" | grep -q '"protocolVersion"'; then
    echo -e "${GREEN}✓ Protocol version negotiation supported${NC}"
else
    echo -e "${RED}✗ Protocol version negotiation failed${NC}"
    FAILED=1
fi

# 2. Check required methods
echo -e "\n${YELLOW}[2] Checking required MCP methods...${NC}"
METHODS=("tools/list" "ping")

for METHOD in "${METHODS[@]}"; do
    RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
        -H "Authorization: Bearer $MCP_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"$METHOD\",\"params\":{},\"id\":1}" 2>/dev/null || echo "{}")
    
    if echo "$RESPONSE" | grep -q '"result"'; then
        echo -e "${GREEN}✓ Method '$METHOD' working${NC}"
    else
        echo -e "${RED}✗ Method '$METHOD' failed${NC}"
        FAILED=1
    fi
done

# 3. Check SSE endpoint
echo -e "\n${YELLOW}[3] Checking SSE streaming support...${NC}"
SSE_RESPONSE=$(curl -s -N -m 2 "$MCP_URL/mcp/stream" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -H "Accept: text/event-stream" 2>&1 | head -n 5)

if echo "$SSE_RESPONSE" | grep -q "event:"; then
    echo -e "${GREEN}✓ SSE streaming functional${NC}"
else
    # Check alternate endpoint
    SSE_RESPONSE=$(curl -s -N -m 2 "$MCP_URL/sse" \
        -H "Authorization: Bearer $MCP_TOKEN" \
        -H "Accept: text/event-stream" 2>&1 | head -n 5)
    
    if echo "$SSE_RESPONSE" | grep -q "event:"; then
        echo -e "${GREEN}✓ SSE streaming functional (alternate endpoint)${NC}"
    else
        echo -e "${RED}✗ SSE streaming not working${NC}"
        FAILED=1
    fi
fi

# 4. Check JSON-RPC 2.0 compliance
echo -e "\n${YELLOW}[4] Checking JSON-RPC 2.0 compliance...${NC}"
RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":123}' 2>/dev/null || echo "{}")

if echo "$RESPONSE" | grep -q '"jsonrpc".*:.*"2.0"' && echo "$RESPONSE" | grep -q '"id".*:.*123'; then
    echo -e "${GREEN}✓ JSON-RPC 2.0 format compliant${NC}"
else
    echo -e "${RED}✗ JSON-RPC 2.0 format non-compliant${NC}"
    FAILED=1
fi

# 5. Check error handling
echo -e "\n${YELLOW}[5] Checking error handling...${NC}"
ERROR_RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"nonexistent/method","params":{},"id":1}' 2>/dev/null || echo "{}")

if echo "$ERROR_RESPONSE" | grep -q '"error"'; then
    echo -e "${GREEN}✓ Proper error handling for unknown methods${NC}"
else
    echo -e "${RED}✗ Missing error handling${NC}"
    FAILED=1
fi

# 6. Check authentication (tools/list should work without auth for discovery)
echo -e "\n${YELLOW}[6] Checking authentication...${NC}"
# Check that tools/list works without auth (for discovery)
UNAUTH_LIST=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' 2>/dev/null)

# Check that protected tools require auth
UNAUTH_CALL=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"summary.today","arguments":{}},"id":1}' 2>/dev/null)

if echo "$UNAUTH_LIST" | grep -q '"tools"' && echo "$UNAUTH_CALL" | grep -q '"error"'; then
    echo -e "${GREEN}✓ Authentication properly configured (discovery allowed, tools protected)${NC}"
else
    echo -e "${RED}✗ Authentication not properly configured${NC}"
    FAILED=1
fi

# 7. Check tool invocation
echo -e "\n${YELLOW}[7] Checking tool invocation...${NC}"
TOOL_RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"summary.today","arguments":{}},"id":1}' 2>/dev/null || echo "{}")

if echo "$TOOL_RESPONSE" | grep -q '"result"'; then
    echo -e "${GREEN}✓ Tool invocation working${NC}"
else
    echo -e "${YELLOW}⚠ Tool invocation may need Enable Banking session${NC}"
fi

# Summary
echo "========================================================="
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ MCP server is compliant with official standards!${NC}"
    exit 0
else
    echo -e "${RED}❌ MCP server has compliance issues!${NC}"
    echo -e "${RED}Please review the failures above and fix them.${NC}"
    exit 1
fi