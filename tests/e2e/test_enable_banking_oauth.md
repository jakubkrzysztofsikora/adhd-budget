# Enable Banking OAuth Testing with MCP Inspector

## Overview
Enable Banking uses OAuth 2.0 for user authentication to access bank accounts. The MCP server exposes Enable Banking tools to manage this flow.

## Authentication Flow

1. **Start OAuth Flow** → Get authorization URL
2. **User Authorizes** → User logs into their bank
3. **Handle Callback** → Exchange code for access token
4. **Sync Transactions** → Use token to fetch bank data

## Testing in MCP Inspector

### 1. Start MCP Inspector
```bash
./setup_mcp_inspector.sh
# Opens at http://localhost:6274
```

### 2. Connect to MCP Server
- MCP server runs at: `http://localhost:8081/mcp`
- No authentication required for local testing
- Or use Bearer token: `test_mcp_token_secure_2024`

### 3. Test Enable Banking OAuth Flow

#### Step 1: Start OAuth Flow
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "enable.banking.auth",
    "arguments": {
      "redirect_uri": "http://localhost:8082/api/auth/callback",
      "state": "test-session-123"
    }
  },
  "id": "1"
}
```

**Expected Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "auth_url": "https://api.sandbox.enablebanking.com/auth/authorize?...",
    "message": "Open this URL in your browser to authorize",
    "state": "test-session-123"
  },
  "id": "1"
}
```

#### Step 2: Simulate OAuth Callback
After user authorizes (or in sandbox, automatically), handle the callback:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "enable.banking.callback",
    "arguments": {
      "code": "test-auth-code-abc123",
      "state": "test-session-123",
      "redirect_uri": "http://localhost:8082/api/auth/callback"
    }
  },
  "id": "2"
}
```

**Expected Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "status": "authenticated",
    "access_token": "mock_access_token_12345",
    "expires_in": 3600,
    "message": "Successfully authenticated with Enable Banking"
  },
  "id": "2"
}
```

#### Step 3: Sync Bank Transactions
Use the access token to sync transactions:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "enable.banking.sync",
    "arguments": {
      "access_token": "mock_access_token_12345"
    }
  },
  "id": "3"
}
```

**Expected Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "status": "synced",
    "transactions_count": 5,
    "accounts": ["GB123456789", "GB987654321"],
    "message": "Successfully synced 5 transactions from 2 accounts",
    "transactions": [
      {"id": "eb-001", "amount": -45.20, "merchant": "Tesco", "date": "2024-01-15"},
      {"id": "eb-002", "amount": -12.50, "merchant": "Costa", "date": "2024-01-15"},
      {"id": "eb-003", "amount": -50.00, "merchant": "TfL", "date": "2024-01-14"},
      {"id": "eb-004", "amount": 2500.00, "merchant": "Salary", "date": "2024-01-01"},
      {"id": "eb-005", "amount": -800.00, "merchant": "Rent", "date": "2024-01-01"}
    ]
  },
  "id": "3"
}
```

## Production vs Sandbox

### Sandbox (Default)
- Uses mock data and responses
- No real bank connection required
- Auth URL: `https://api.sandbox.enablebanking.com`
- Test with any code/state values

### Production
- Requires real Enable Banking credentials
- User must authenticate with real bank
- Auth URL: `https://api.enablebanking.com`
- Requires valid JWT signing with private key

## Security Notes

1. **OAuth State Parameter**: Always validate to prevent CSRF attacks
2. **Access Tokens**: Store securely, never log or expose
3. **Redirect URI**: Must match registered URI in Enable Banking
4. **JWT Authentication**: Production requires RS256 signed JWTs

## Troubleshooting

### "Missing access token" Error
Run the OAuth flow first:
1. Call `enable.banking.auth`
2. Call `enable.banking.callback` with code
3. Use returned access_token in `enable.banking.sync`

### "Invalid authorization code" Error
- Ensure code hasn't expired (10 minutes validity)
- Check redirect_uri matches exactly
- Verify state parameter matches

### Connection Issues
```bash
# Check MCP server is running
docker compose ps mcp-server

# Check logs
docker compose logs -f mcp-server

# Restart if needed
docker compose restart mcp-server
```

## Full Test Script
```javascript
// In MCP Inspector console:
// 1. Start auth
await client.call('tools/call', {
  name: 'enable.banking.auth',
  arguments: { state: 'test-123' }
});

// 2. Handle callback (simulate)
await client.call('tools/call', {
  name: 'enable.banking.callback',
  arguments: { 
    code: 'test-code',
    state: 'test-123'
  }
});

// 3. Sync transactions
await client.call('tools/call', {
  name: 'enable.banking.sync',
  arguments: {
    access_token: 'mock_access_token_12345'
  }
});
```