#!/bin/bash
# Comprehensive MCP Connector Integration Test
# Tests both ChatGPT and Claude Web connector integration

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

MCP_ENDPOINT="https://adhdbudget.bieda.it/mcp"
OAUTH_DISCOVERY="https://adhdbudget.bieda.it/.well-known/oauth-authorization-server"
MCP_MANIFEST="https://adhdbudget.bieda.it/.well-known/mcp.json"

echo "=========================================="
echo "MCP Connector Integration Test"
echo "=========================================="
echo ""

# Test 1: MCP Manifest Discovery
echo -e "${YELLOW}Test 1: MCP Manifest Discovery${NC}"
MANIFEST=$(curl -s "$MCP_MANIFEST")
if echo "$MANIFEST" | jq -e '.name == "adhd-budget-mcp"' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ MCP manifest is accessible and valid${NC}"
    echo "  Name: $(echo "$MANIFEST" | jq -r '.name')"
    echo "  Version: $(echo "$MANIFEST" | jq -r '.version')"
    echo "  Protocol Versions: $(echo "$MANIFEST" | jq -r '.protocolVersions | join(", ")')"
else
    echo -e "${RED}✗ MCP manifest is invalid or inaccessible${NC}"
    exit 1
fi
echo ""

# Test 2: OAuth Discovery
echo -e "${YELLOW}Test 2: OAuth Discovery${NC}"
OAUTH=$(curl -s "$OAUTH_DISCOVERY")
if echo "$OAUTH" | jq -e '.issuer' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ OAuth discovery endpoint is accessible${NC}"
    echo "  Issuer: $(echo "$OAUTH" | jq -r '.issuer')"
    echo "  Authorization: $(echo "$OAUTH" | jq -r '.authorization_endpoint')"
    echo "  Token: $(echo "$OAUTH" | jq -r '.token_endpoint')"
    echo "  Registration: $(echo "$OAUTH" | jq -r '.registration_endpoint')"
else
    echo -e "${RED}✗ OAuth discovery endpoint is invalid${NC}"
    exit 1
fi
echo ""

# Test 3: MCP Initialize
echo -e "${YELLOW}Test 3: MCP Protocol Initialization${NC}"
INIT_RESPONSE=$(curl -s "$MCP_ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"roots":{}}},"id":1}')

if echo "$INIT_RESPONSE" | jq -e '.result.protocolVersion' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ MCP initialization successful${NC}"
    echo "  Protocol Version: $(echo "$INIT_RESPONSE" | jq -r '.result.protocolVersion')"
    echo "  Server Name: $(echo "$INIT_RESPONSE" | jq -r '.result.serverInfo.name')"
    echo "  Server Version: $(echo "$INIT_RESPONSE" | jq -r '.result.serverInfo.version')"
else
    echo -e "${RED}✗ MCP initialization failed${NC}"
    echo "Response: $INIT_RESPONSE"
    exit 1
fi
echo ""

# Test 4: Tools List
echo -e "${YELLOW}Test 4: MCP Tools Discovery${NC}"
TOOLS_RESPONSE=$(curl -s "$MCP_ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":2}')

TOOL_COUNT=$(echo "$TOOLS_RESPONSE" | jq -r '.result.tools | length')
if [ "$TOOL_COUNT" -gt 0 ]; then
    echo -e "${GREEN}✓ Tools list retrieved successfully${NC}"
    echo "  Total tools: $TOOL_COUNT"
    echo ""
    echo "  Available tools:"
    echo "$TOOLS_RESPONSE" | jq -r '.result.tools[] | "    - \(.name): \(.description)"'
else
    echo -e "${RED}✗ No tools found${NC}"
    exit 1
fi
echo ""

# Test 5: OAuth Client Registration
echo -e "${YELLOW}Test 5: OAuth Client Registration${NC}"
CLIENT_REG=$(curl -s -X POST "https://adhdbudget.bieda.it/oauth/register" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"Test Integration Client","client_uri":"https://test.example.com","redirect_uris":["https://test.example.com/callback"]}')

if echo "$CLIENT_REG" | jq -e '.client_id' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ OAuth client registration successful${NC}"
    CLIENT_ID=$(echo "$CLIENT_REG" | jq -r '.client_id')
    echo "  Client ID: $CLIENT_ID"

    # Check for ChatGPT and Claude redirect URIs
    CHATGPT_REDIRECTS=$(echo "$CLIENT_REG" | jq -r '.redirect_uris[] | select(contains("chatgpt") or contains("openai"))' | wc -l)
    CLAUDE_REDIRECTS=$(echo "$CLIENT_REG" | jq -r '.redirect_uris[] | select(contains("claude"))' | wc -l)

    echo "  ChatGPT redirect URIs: $CHATGPT_REDIRECTS"
    echo "  Claude redirect URIs: $CLAUDE_REDIRECTS"

    if [ "$CHATGPT_REDIRECTS" -gt 0 ] && [ "$CLAUDE_REDIRECTS" -gt 0 ]; then
        echo -e "${GREEN}✓ Both ChatGPT and Claude redirect URIs are configured${NC}"
    else
        echo -e "${RED}✗ Missing redirect URIs for some platforms${NC}"
        exit 1
    fi
else
    echo -e "${RED}✗ OAuth client registration failed${NC}"
    echo "Response: $CLIENT_REG"
    exit 1
fi
echo ""

# Test 6: HTTPS and Security Headers
echo -e "${YELLOW}Test 6: Security Headers${NC}"
HEADERS=$(curl -s -I "$MCP_ENDPOINT")
if echo "$HEADERS" | grep -i "strict-transport-security" > /dev/null; then
    echo -e "${GREEN}✓ HSTS header is present${NC}"
else
    echo -e "${YELLOW}⚠ HSTS header missing (consider adding for production)${NC}"
fi

if echo "$HEADERS" | grep -i "HTTP/2" > /dev/null; then
    echo -e "${GREEN}✓ HTTP/2 is enabled${NC}"
else
    echo -e "${YELLOW}⚠ HTTP/2 not detected${NC}"
fi
echo ""

# Summary
echo "=========================================="
echo -e "${GREEN}All Core Tests Passed!${NC}"
echo "=========================================="
echo ""
echo "Next Steps for Manual Testing:"
echo "1. ChatGPT: Go to https://chatgpt.com/#settings/Connectors"
echo "   - Click 'Advanced settings' → 'Developer Mode'"
echo "   - Add connector: $MCP_ENDPOINT"
echo "   - Complete OAuth flow"
echo "   - Test query: 'What's my spending summary today from ADHD budget?'"
echo ""
echo "2. Claude Web: Go to Claude connector settings"
echo "   - Add connector: $MCP_ENDPOINT"
echo "   - Complete OAuth flow"
echo "   - Test similar query"
echo ""
echo "The server is ready and properly configured for both platforms!"
