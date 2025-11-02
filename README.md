# ADHD Budget Assistant

An automated financial tracking system designed for ADHD households - zero manual reconciliation required.

**Live Instance:** https://adhdbudget.bieda.it

## Overview

The ADHD Budget Assistant automatically:
- Collects transactions from Enable Banking API with OAuth 2.0
- Categorizes spending using ML
- Sends daily WhatsApp summaries
- Provides financial projections
- Integrates with AI agents via MCP (Model Context Protocol)

## Quick Start

### Local Development

```bash
# Clone repository
git clone https://github.com/jakubkrzysztofsikora/adhd-budget.git
cd adhd-budget

# Copy environment variables
cp .env.example .env
# Edit .env with your credentials

# Start services
docker compose up -d

# Verify all services are running
docker compose ps

# Run tests
./tests/shell/scan_git_secrets.sh  # S1: Secrets audit
./tests/shell/check_compose_security.sh  # S4: Container security
```

### Access Points

- **Main App:** http://localhost
- **API:** http://localhost:8082
- **MCP Server:** http://localhost:8000/mcp (streamable HTTP)
- **OAuth Flow:** http://localhost/oauth/authorize
- **MCP Inspector:** http://localhost:6274 (development)
- **Log Viewer:** http://localhost:8888 (MCP server logs with mTLS)
- **Health Check:** http://localhost/health

## MCP Remote Server

The MCP server implements the 2025-06-18 protocol with streamable HTTP
transport. It validates the ``MCP-Protocol-Version`` header, enforces
origin allow lists and requires OAuth 2.1 bearer tokens for protected tools.

### Run locally

```bash
python src/mcp_remote_server.py
# Server listens on http://127.0.0.1:8000/mcp
```

Set ``MCP_PORT`` and ``MCP_HOST`` to override the bind address. For example,
Docker Compose sets ``MCP_PORT=8081`` and ``MCP_HOST=0.0.0.0`` so that other
containers and the reverse proxy can reach the service while local execution
continues to default to ``127.0.0.1`` for safety.

### Test the handshake

```bash
curl -X POST http://127.0.0.1:8000/mcp \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0.1.0"}}}'
```

Use the ``Mcp-Session-Id`` response header for subsequent POST requests and
the SSE stream:

```bash
curl -N http://127.0.0.1:8000/mcp \
  -H "Accept: text/event-stream" \
  -H "Mcp-Session-Id: <session-id>" \
  -H "MCP-Protocol-Version: 2025-06-18"
```

### OAuth endpoints

The server exposes OAuth 2.1 discovery and token endpoints required for
remote deployments:

- ``/.well-known/oauth-authorization-server`` – metadata
- ``/.well-known/oauth-protected-resource`` – RFC 8707 resource indicators
- ``/.well-known/mcp.json`` – Remote MCP manifest (ChatGPT Developer Mode & Claude Web)
- ``/oauth/register`` – Dynamic Client Registration (POST JSON)
- ``/oauth/authorize`` – Issues authorization codes and redirects
- ``/oauth/token`` – Exchanges authorization codes or refresh tokens
- ``/oauth/revoke`` – Revokes access or refresh tokens

The server automatically seeds Claude and ChatGPT redirect URIs (see
``DEFAULT_REMOTE_REDIRECT_URIS``) and mirrors any ``X-Forwarded-Proto`` /
``X-Forwarded-Host`` headers so manifests and OAuth metadata point at the
public hostname behind your reverse proxy. Deployments can override the
issuer explicitly with ``OAUTH_ISSUER`` if required.

### Remote connector setup

Remote MCP clients discover the server through the ``/.well-known/mcp.json``
manifest. The manifest advertises the streamable HTTP endpoint, supported
protocol versions and OAuth 2.1 configuration so that connectors such as
ChatGPT Developer Mode and Claude Web/Desktop can configure themselves
automatically.

**ChatGPT Developer Mode**

1. Deploy the server behind HTTPS (e.g. ``https://mcp.example.com``).
2. Ensure the domain is reachable from ChatGPT and that the manifest is
   accessible at ``https://mcp.example.com/.well-known/mcp.json``.
3. In ChatGPT → Settings → Connectors → Advanced → Developer Mode, add the
   base URL (``https://mcp.example.com``). ChatGPT performs discovery and
   dynamic registration automatically.
4. The OAuth server now issues HTTP 302 redirects directly to the ChatGPT
   callback and recognises the entire ``https://chat.openai.com/`` redirect
   family (``DEFAULT_REMOTE_REDIRECT_URIS``) even in production builds.

**Claude Web & Desktop**

1. Visit Claude → Settings → Remote Desktops → Add new.
2. Enter your HTTPS endpoint (e.g. ``https://mcp.example.com``). Claude fetches
   ``/.well-known/mcp.json`` (respecting forwarded headers) and registers a
   client automatically.
3. Complete the OAuth flow—the server now returns a 302 redirect straight back
   to Claude's callback URL and accepts the ``https://claude.ai/`` and
   ``https://app.claude.ai/`` variants out of the box.
4. Claude Desktop can still connect locally via ``npx mcp-remote`` during
   development if you prefer not to expose the service publicly.

### Verifying with MCP Inspector

Run the official Inspector container against your deployment:

```bash
docker run --rm -it \
  -e MCP_SERVER_URL="https://mcp.example.com/mcp" \
  ghcr.io/modelcontextprotocol/inspector:latest
```

The inspector follows the same manifest + OAuth flow and should list the
available tools once authentication succeeds.

## Deployment Pipeline

### 1. Development Flow

```bash
# Make changes
git add .
git commit -m "Your changes"

# Ensure all tests pass locally
./tests/shell/scan_git_secrets.sh
./tests/shell/check_compose_security.sh

# Push to GitHub
git push origin main
```

### 2. CI/CD Pipeline

The GitHub Actions pipeline automatically:

1. **Runs Security Gates:**
   - S1: Secrets hygiene audit
   - S4: Container security checks

2. **Runs Technical Gates:**
   - T1/T4: Docker Compose & MCP integration
   - T2/T5: Data flow & scheduling
   - T3: Unit tests (Python 3.9, 3.10, 3.11)

3. **Deploys to VPS** (on main branch):
   - Copies source files to VPS
   - Builds Docker images on VPS
   - Starts services with production configs

### 3. Required GitHub Secrets

Configure these in Settings > Secrets and variables > Actions:

- `VPS_HOST`: Your VPS IP/hostname
- `VPS_USER`: SSH username
- `VPS_SSH_PASSWORD`: SSH password
- `VPS_SSH_PORT`: SSH port (usually 22)
- `PROD_DB_PASSWORD`: Production database password
- `PROD_MCP_TOKEN`: MCP authentication token
- `PROD_API_TOKEN`: API authentication token
- `ENABLE_APP_ID`: Enable Banking application ID
- `ENABLE_PRIVATE_KEY`: Full PEM private key content
- `ENABLE_API_URL`: Enable Banking API URL
- `DOMAIN`: Your domain (as variable, not secret)

## Testing Protocol

### Pre-Deployment (Local)

```bash
# 1. Security checks
./tests/shell/scan_git_secrets.sh
./tests/shell/check_compose_security.sh

# 2. Run unit tests
python -m pytest tests/unit/ -v

# 3. Integration tests (requires Docker)
docker compose up -d
python -m pytest tests/integration/ -v
```

### Post-Deployment (Production)

```bash
# 1. Run E2E tests against production
python3 tests/e2e/test_deployed_instance.py

# 2. Test with MCP Inspector or Claude Desktop
./setup_mcp_inspector.sh
# Configure Inspector or Claude Desktop with the streamable HTTP transport:
#   http://127.0.0.1:8000/mcp
# Add the OAuth client via /oauth/register and complete the authorization code flow.

# 3. Verify authenticated endpoints
curl -H "Authorization: Bearer YOUR_API_TOKEN" https://adhdbudget.bieda.it/api/health
```

### Test Results

All gates must pass before deployment:

| Gate | Description | Status |
|------|-------------|--------|
| S1 | Secrets hygiene | ✅ |
| S4 | Container security | ✅ |
| T1/T4 | Compose & MCP | ✅ |
| T2/T5 | Data flow | ✅ |
| T3 | Unit tests | ✅ |

## Log Viewer

The log-viewer service provides HTTP access to MCP server logs with mTLS authentication.

### Quick Access (Development)
```bash
# View logs (no certificates required in dev mode)
curl http://localhost:8888/logs/stream

# Health check
curl http://localhost:8888/health
```

### Production Access (with mTLS)
```bash
# Generate certificates
bash scripts/generate-log-viewer-certs.sh

# Access with mTLS
curl https://localhost:8888/logs/stream \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key
```

See [LOG_VIEWER_QUICKSTART.md](LOG_VIEWER_QUICKSTART.md) for complete documentation.

## Architecture

```
┌─────────────────┐
│  Reverse Proxy  │ (Caddy with HTTPS)
└────────┬────────┘
         │
    ┌────┴────┐
    │   API   │ (Python FastAPI)
    └────┬────┘
         │
┌────────┴────────┐
│   MCP Server    │ (JSON-RPC over SSE)
└────────┬────────┘
         │
┌────────┴────────┐
│    Database     │ (PostgreSQL)
└─────────────────┘
         │
┌────────┴────────┐
│     Worker      │ (Python - Enable Banking sync)
└─────────────────┘
         │
┌────────┴────────┐
│     Redis       │ (Cache & queues)
└─────────────────┘
```

## Security

- No default passwords (all require environment variables)
- All containers run as non-root (except DB)
- Capability drops and resource limits enforced
- SSL/TLS with Let's Encrypt
- Bearer token authentication for API/MCP
- Private keys stored as GitHub secrets

## Enable Banking Integration

1. Register at https://enablebanking.com
2. Upload certificate, get application ID
3. Configure environment variables:
   - `ENABLE_APP_ID`
   - `ENABLE_PRIVATE_KEY`
   - `ENABLE_API_URL`

## WhatsApp Integration

Configure WhatsApp Business Cloud API:
- `WHATSAPP_PHONE_ID`
- `WHATSAPP_TOKEN`
- `WHATSAPP_WEBHOOK_SECRET`

## Known Issues & Workarounds

### HTTPS URLs in OAuth Discovery
**Issue**: OAuth discovery returns HTTP URLs instead of HTTPS on production
**Cause**: Reverse proxy not forwarding `X-Forwarded-Proto` header
**Workaround**: Configure the proxy to forward scheme information so `src/mcp_remote_server.py` can emit HTTPS URLs
**Fix**: Update nginx configuration on VPS to include:
```nginx
proxy_set_header X-Forwarded-Proto https;
```

## Troubleshooting

### Services not starting
```bash
# Check logs
docker compose logs -f

# Verify environment variables
docker compose config

# Restart services
docker compose down
docker compose up -d
```

### Deployment failures
- Verify all GitHub secrets are set
- Check VPS has Docker installed
- Ensure VPS user has docker permissions
- Check SSH connectivity

## License

MIT

## Support

Report issues at: https://github.com/jakubkrzysztofsikora/adhd-budget/issues