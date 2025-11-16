# Enable Banking OAuth Testing with MCP Inspector

## Overview

Enable Banking uses OAuth 2.0 for user authentication to access bank accounts.
The remote MCP server now wires the Enable Banking consent directly into its
OAuth flow – when a connector begins `/oauth/authorize` the server immediately
redirects the browser to Enable Banking so the user can pick their bank and
approve access. Once consent completes the server exchanges the code, stores the
API tokens in the OAuth grant and redirects back to the connector.

## Authentication Flow

1. **Connector launches `/oauth/authorize`** – MCP server validates the client.
2. **Server redirects to Enable Banking** – user completes their bank’s login.
3. **Enable Banking calls `/oauth/enable-banking/callback`** – server exchanges
   the code for access/refresh tokens and issues an OAuth authorization code.
4. **Connector exchanges the code at `/oauth/token`** – resulting access tokens
   automatically include the Enable Banking session so financial tools can run.

## Testing in MCP Inspector

### 1. Start MCP Inspector

```bash
./setup_mcp_inspector.sh
# Opens at http://localhost:6274
```

### 2. Connect to MCP Server

- MCP server runs at: `http://localhost:8081/mcp`
- Inspector automatically discovers the manifest and OAuth endpoints
- No manual bearer token is required; use the OAuth button inside Inspector

### 3. Walk the OAuth + Enable Banking Flow

1. Click **Connect** → **Authorize** in MCP Inspector.
2. A browser window opens showing the Enable Banking consent screen.
3. Select a sandbox bank (e.g. `MOCKASPSP_SANDBOX`) and finish login.
4. Once consent succeeds the browser is redirected back to MCP Inspector.
5. Inspector now has a valid OAuth access token that already contains the
   Enable Banking session; you can immediately run tools such as
   `summary.today`, `projection.month`, `search`, `fetch`, or `transactions.query`.

### 4. Verify Tool Access

Use Inspector’s console to run a protected tool after OAuth:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "summary.today",
    "arguments": {}
  },
  "id": "1"
}
```

You should receive live Enable Banking data without any intermediate auth tools.

## Automated E2E Suite

To exercise the fully automated flow in `tests/e2e/test_enable_banking_oauth_complete.py`:

1. Ensure a remote MCP deployment is reachable and export `TEST_BASE_URL` (or
   `E2E_BASE_URL`) with its origin, e.g. `https://adhdbudget.bieda.it`. The
   automated suite now probes both `/health` **and**
   `/.well-known/oauth-authorization-server`; if either returns 5xx, the suite
   is skipped so CI doesn’t fail with "502 Bad Gateway" during outages.
2. Complete a manual Enable Banking consent once and copy the resulting OAuth
   authorization code into `MCP_TEST_AUTH_CODE` (or set
   `MCP_TEST_ACCESS_TOKEN`/`MCP_TEST_REFRESH_TOKEN` if you already have valid
   tokens).
3. Run `pytest tests/e2e/test_enable_banking_oauth_complete.py -v`.

The test suite now probes the `/health` endpoint up front and skips gracefully
when the remote server or Enable Banking credentials are unavailable, avoiding
the previous "502 Bad Gateway" failures.

## Production vs Sandbox

### Sandbox (Default)
- Uses Enable Banking’s sandbox ASPSP list (`MOCKASPSP_SANDBOX`)
- Configure `ENABLE_APP_ID`, `ENABLE_PRIVATE_KEY_PATH`, `ENABLE_ENV=sandbox`
- OAuth redirect will point at `https://api.sandbox.enablebanking.com`

### Production
- Set `ENABLE_ENV=production` and use production credentials/certificates
- Register the `/oauth/enable-banking/callback` URL with Enable Banking
- Users will see their real bank’s login screen during the OAuth flow

## Security Notes

1. **OAuth State Parameter**: The MCP server maintains its own state per
   consent and rejects expired/unknown states.
2. **Access Tokens**: Tokens returned by `/oauth/token` already encapsulate the
   Enable Banking session; treat them like sensitive financial credentials.
3. **Redirect URI**: Make sure the value passed to `/oauth/authorize` matches
   the URI registered with the MCP server during dynamic client registration.
4. **Token Refresh**: The server refreshes Enable Banking tokens automatically
   and keeps the refreshed values associated with the OAuth access/refresh
   tokens, so connectors don’t need extra tooling.

## Troubleshooting

- **OAuth loop stops at Enable Banking**: verify `ENABLE_APP_ID` and
  `ENABLE_PRIVATE_KEY_PATH` are set and that the `/oauth/enable-banking/callback`
  URL is registered in the Enable Banking dashboard.
- **Connector says “No Enable Banking consent”**: disconnect/reconnect the MCP
  connector so the OAuth flow (and thus the Enable Banking redirect) can run
  again.
- **Invalid redirect URI**: ensure your reverse proxy forwards
  `X-Forwarded-Proto`/`Host` correctly so the manifest and OAuth metadata refer
  to the public HTTPS hostname.
