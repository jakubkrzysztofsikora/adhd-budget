# Claude Desktop Empty Tools Fix

## Problem
Claude Desktop showed a connected custom connector but no tools appeared in the tool picker.

## Root Causes
1. **CORS Wildcard**: Server was using `Access-Control-Allow-Origin: *` which Claude Desktop doesn't accept for security
2. **Schema Property**: Using `inputSchema` instead of `input_schema` (MCP spec requires underscore)

## Solution

### 1. CORS Allowlist
Replaced wildcard with specific origin allowlist:
```python
ALLOWED_ORIGINS = {
    'https://claude.ai',
    'https://claude.com',  # Future-proofing
    'http://localhost:6274',  # MCP Inspector
    'http://localhost:6277'   # MCP Inspector
}
```

### 2. Fixed Schema Property
Changed all tool definitions from `inputSchema` to `input_schema`:
```json
{
  "name": "tool_name",
  "description": "Tool description",
  "input_schema": {  // <- Fixed: was "inputSchema"
    "type": "object",
    "properties": {}
  }
}
```

### 3. Proper Preflight Response
- Return `204 No Content` (standard for OPTIONS)
- Include `Vary: Origin` header for caching
- Add `Access-Control-Max-Age` for preflight caching

## Testing

### Preflight Test
```bash
curl -i -X OPTIONS "https://adhdbudget.bieda.it/mcp" \
  -H "Origin: https://claude.ai" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type, authorization, accept"
```

Expected response:
```
HTTP/2 204
Access-Control-Allow-Origin: https://claude.ai
Vary: Origin
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, Accept
Access-Control-Max-Age: 86400
```

### Tools List Test
```bash
curl -s -X POST "https://adhdbudget.bieda.it/mcp" \
  -H "Origin: https://claude.ai" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' | jq '.result.tools[0]'
```

Expected: Tools with `input_schema` property (not `inputSchema`)

## Security Notes
- Never use wildcard `*` for CORS on authenticated endpoints
- Always validate origin against an allowlist
- Use `Vary: Origin` to prevent cache poisoning

## Rollback Plan
If issues arise, revert commit 9ab668d:
```bash
git revert 9ab668d
git push origin main
```

## Follow-up Actions
1. Add integration test for CORS preflight
2. Add test for correct schema property names
3. Monitor Claude Desktop usage logs