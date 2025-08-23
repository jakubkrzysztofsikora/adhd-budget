# MCP Inspector - Manual E2E Test

## Overview
Manual testing of MCP server using the MCP Inspector tool to verify JSON-RPC 2.0 compliance and SSE streaming.

## Setup Instructions

### 1. Install MCP Inspector

```bash
# Clone the MCP Inspector
git clone https://github.com/modelcontextprotocol/inspector.git ../mcp-inspector
cd ../mcp-inspector

# Install dependencies
npm install

# Build the inspector
npm run build
```

### 2. Start the ADHD Budget Services

```bash
# From the adhd-budget directory
cd /Users/jakubsikora/Repos/personal/adhd-budget

# Start all services
docker compose up -d

# Verify services are running
docker compose ps

# Check MCP server health
curl http://localhost:8081/health
```

### 3. Configure MCP Inspector

Create a configuration file for the inspector:

```bash
cat > ../mcp-inspector/config.json << 'EOF'
{
  "servers": [
    {
      "name": "ADHD Budget MCP",
      "url": "http://localhost:8081/mcp",
      "transport": "sse",
      "auth": {
        "type": "bearer",
        "token": "${MCP_TOKEN:-secret}"
      }
    }
  ]
}
EOF
```

### 4. Run MCP Inspector

```bash
# Start the inspector
cd ../mcp-inspector
npm start

# Open browser to http://localhost:3000
```

## Manual Test Checklist

### T4 Gate Validation

#### 1. Connect to MCP Server
- [ ] Open Inspector at http://localhost:3000
- [ ] Select "ADHD Budget MCP" from server list
- [ ] Verify connection established
- [ ] Check for SSE transport confirmation

#### 2. List Available Tools
- [ ] Send request: `{"jsonrpc": "2.0", "method": "tools/list", "id": "1"}`
- [ ] Verify response contains:
  - [ ] `summary.today`
  - [ ] `projection.month`
  - [ ] `transactions.query`

#### 3. Test Tool Invocations

**summary.today**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "summary.today",
    "arguments": {}
  },
  "id": "2"
}
```
- [ ] Verify response contains daily summary data
- [ ] Check all required fields present

**projection.month**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "projection.month",
    "arguments": {}
  },
  "id": "3"
}
```
- [ ] Verify monthly projections returned
- [ ] Check pace calculation present

**transactions.query**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "transactions.query",
    "arguments": {
      "since": "2024-01-01T00:00:00Z",
      "limit": 10
    }
  },
  "id": "4"
}
```
- [ ] Verify transactions returned
- [ ] Check filtering works

#### 4. Test Streaming
- [ ] Enable streaming mode in inspector
- [ ] Send long-running query
- [ ] Verify chunks arrive incrementally
- [ ] Confirm no WebSocket usage (SSE only)

#### 5. Error Handling
- [ ] Send malformed JSON-RPC request
- [ ] Verify proper error response (-32700)
- [ ] Send unknown method
- [ ] Verify method not found error (-32601)
- [ ] Send invalid params
- [ ] Verify invalid params error (-32602)

## Quick Test Commands

Run these commands in parallel terminals to test the full system:

### Terminal 1: Start Services
```bash
cd /Users/jakubsikora/Repos/personal/adhd-budget
docker compose up
```

### Terminal 2: Test MCP Directly
```bash
# Test MCP endpoint
curl -X POST http://localhost:8081/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MCP_TOKEN:-secret}" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":"1"}'

# Test SSE streaming
curl -N -H "Accept: text/event-stream" \
  -H "Authorization: Bearer ${MCP_TOKEN:-secret}" \
  http://localhost:8081/mcp/stream
```

### Terminal 3: Run Inspector
```bash
cd ../mcp-inspector
npm start
# Open http://localhost:3000
```

## Success Criteria

✅ All MCP tools listed correctly
✅ Tools can be invoked with proper responses
✅ SSE streaming works without buffering
✅ No WebSocket connections used
✅ JSON-RPC 2.0 compliance verified
✅ Error handling follows spec

## Troubleshooting

### Inspector won't connect
```bash
# Check MCP server is running
docker compose logs mcp-server

# Test direct connection
curl http://localhost:8081/health

# Check auth token
echo $MCP_TOKEN
```

### SSE not streaming
```bash
# Check proxy configuration
docker compose exec reverse-proxy cat /etc/caddy/Caddyfile | grep flush

# Test streaming directly
curl -N http://localhost:8081/mcp/stream
```

### Tools not working
```bash
# Check Python modules loaded
docker compose exec mcp-server python -c "import mcp_server; print('OK')"

# View logs
docker compose logs -f mcp-server
```

## Automated Verification

After manual testing, run automated verification:

```bash
# Run MCP integration tests
pytest tests/integration/test_mcp_streaming.py -v

# Verify all gates
make validate-gates
```

---

*Last tested: [DATE]*
*Tester: [NAME]*
*Result: [PASS/FAIL]*