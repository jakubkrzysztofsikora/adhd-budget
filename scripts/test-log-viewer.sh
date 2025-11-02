#!/bin/bash
set -e

echo "=========================================="
echo "Testing Log Viewer Service"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test health endpoint
echo "Test 1: Health Check"
echo "-------------------"
HEALTH_RESPONSE=$(curl -s http://localhost:8888/health)
if echo "$HEALTH_RESPONSE" | grep -q '"status": "healthy"'; then
    echo -e "${GREEN}✓ Health check passed${NC}"
    echo "$HEALTH_RESPONSE"
else
    echo -e "${RED}✗ Health check failed${NC}"
    echo "$HEALTH_RESPONSE"
    exit 1
fi
echo ""

# Test logs endpoint (JSON)
echo "Test 2: Logs Endpoint (JSON)"
echo "----------------------------"
LOGS_RESPONSE=$(curl -s http://localhost:8888/logs)
if echo "$LOGS_RESPONSE" | grep -q '"log_dir"'; then
    echo -e "${GREEN}✓ Logs endpoint accessible${NC}"
    echo "$LOGS_RESPONSE" | head -20
else
    echo -e "${YELLOW}⚠ Logs endpoint returned unexpected response${NC}"
    echo "$LOGS_RESPONSE"
fi
echo ""

# Test logs stream endpoint
echo "Test 3: Logs Stream Endpoint (Plain Text)"
echo "-----------------------------------------"
STREAM_RESPONSE=$(curl -s http://localhost:8888/logs/stream)
if [ -n "$STREAM_RESPONSE" ]; then
    echo -e "${GREEN}✓ Logs stream endpoint accessible${NC}"
    echo "$STREAM_RESPONSE" | head -30
else
    echo -e "${YELLOW}⚠ No logs available yet${NC}"
    echo "This is normal if MCP server just started."
fi
echo ""

# Test with MCP server health to generate logs
echo "Test 4: Trigger MCP Server Activity"
echo "-----------------------------------"
MCP_HEALTH=$(curl -s http://localhost:8081/health)
if echo "$MCP_HEALTH" | grep -q '"status"'; then
    echo -e "${GREEN}✓ MCP server responding${NC}"
    echo "$MCP_HEALTH"
else
    echo -e "${RED}✗ MCP server not responding${NC}"
fi
echo ""

# Wait a moment for logs to be written
echo "Waiting 3 seconds for logs to be written..."
sleep 3
echo ""

# Check logs again
echo "Test 5: Verify Logs After Activity"
echo "----------------------------------"
LOGS_AFTER=$(curl -s http://localhost:8888/logs/stream)
if [ -n "$LOGS_AFTER" ]; then
    echo -e "${GREEN}✓ Logs available${NC}"
    echo "Last 20 lines:"
    echo "$LOGS_AFTER" | tail -20
else
    echo -e "${YELLOW}⚠ Still no logs available${NC}"
    echo "MCP server might not be logging to file yet."
fi
echo ""

# Test certificate status (if they exist)
echo "Test 6: Certificate Status"
echo "--------------------------"
if [ -f "certs/server.crt" ] && [ -f "certs/client.crt" ]; then
    echo -e "${GREEN}✓ Certificates exist${NC}"
    echo "Server certificate:"
    openssl x509 -in certs/server.crt -noout -subject -dates 2>/dev/null || echo "Error reading certificate"
    echo ""
    echo "Client certificate:"
    openssl x509 -in certs/client.crt -noout -subject -dates 2>/dev/null || echo "Error reading certificate"
    echo ""
    echo "To use mTLS, restart the service:"
    echo "  docker compose restart log-viewer"
else
    echo -e "${YELLOW}⚠ Certificates not found${NC}"
    echo "Service running in insecure HTTP mode (development only)."
    echo ""
    echo "To generate certificates:"
    echo "  bash scripts/generate-log-viewer-certs.sh"
fi
echo ""

# Summary
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo ""
echo -e "${GREEN}✓ Log viewer service is operational${NC}"
echo ""
echo "Available endpoints:"
echo "  • Health:        http://localhost:8888/health"
echo "  • Logs (JSON):   http://localhost:8888/logs"
echo "  • Logs (Stream): http://localhost:8888/logs/stream"
echo ""
echo "Documentation:"
echo "  • Quick Start:   LOG_VIEWER_QUICKSTART.md"
echo "  • Full Docs:     docs/LOG_VIEWER.md"
echo "  • Setup Guide:   docs/SETUP_LOG_VIEWER.md"
echo ""
