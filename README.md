# ADHD Budget Assistant — Polish Bank Gateway

An automated, zero-reconciliation financial intelligence gateway designed for ADHD households. Connects safely to Polish bank accounts (**PKO Bank Polski**, **Nest Bank**, **Revolut**) and exposes high-value financial tools to your AI assistants (**Claude AI**, **Claude Code**, **Kimi Desktop**, **Odysseus Web**) via the Model Context Protocol (MCP).

**Live Instance:** https://adhdbudget.bieda.it  
**Bank Connection Hub:** https://adhdbudget.bieda.it/connect

---

## Key Features (Pareto 80/20 Architecture)

1. **Unified Multi-Bank Hub:** One single gateway connects to PKO BP, Nest Bank, and Revolut simultaneously. No fragmented multi-container setups.
2. **Safe & Decoupled Bank Auth:** Connect your banks once every 90–180 days via a clean web UI at `/connect`. Read-only PSD2 AIS (Account Information Services) only — no payment initiation capabilities.
3. **Dual AI Authentication:**
   - **OAuth 2.1 (PKCE & DCR):** For remote web clients like **Claude AI (Web)** and **Odysseus Web**.
   - **Static Bearer Token:** For local CLI and desktop clients like **Claude Code**, **Kimi Desktop**, and **Odysseus Web**.
4. **5 High-Value ADHD Analysis Tools:**
   - `get_financial_snapshot` — Unified liquid balances across all banks in PLN/EUR + total net worth and consent health.
   - `get_spending_analysis` — Spending velocity, top Polish merchants (Biedronka, Żabka, Orlen, Allegro), outlier impulse buys (>2 std dev), and internal transfer deduplication (e.g. PKO → Revolut topups are excluded from spending).
   - `query_transactions` — Multi-bank search by merchant, date, amount range, and category.
   - `get_recurring_bills` — Detection of fixed bills and subscriptions (Netflix, Spotify, Gym, czynsz, telecom).
   - `get_cashflow_forecast` — ADHD "Safe-to-Spend" daily allowance and projected month-end balance based on current burn rate.

---

## Quick Setup Guide

### 1. Connect Your Banks

1. Visit your deployed instance at `https://adhdbudget.bieda.it/connect` (or `http://localhost:8081/connect` locally).
2. Click **Connect** next to:
   - **PKO Bank Polski**
   - **Nest Bank**
   - **Revolut**
3. Complete the bank's strong customer authentication (SCA).
4. The dashboard will show your connected accounts, balances, and remaining days of consent.

---

## Connecting Your AI Clients

### 1. Claude Code (CLI)

Add the MCP gateway using Claude Code's CLI with your Bearer token:

```bash
claude mcp add --transport http adhd-budget https://adhdbudget.bieda.it/mcp --header "Authorization: Bearer <YOUR_MCP_TOKEN>"
```

*(For local development: use `http://localhost:8081/mcp`)*

### 2. Kimi Desktop

In Kimi Desktop Settings → Model Context Protocol / Tools:

- **Transport:** HTTP / Streamable HTTP (or SSE)
- **URL:** `https://adhdbudget.bieda.it/mcp`
- **Headers:**
  ```
  Authorization: Bearer <YOUR_MCP_TOKEN>
  ```

### 3. Odysseus Web

Configure Odysseus with the streamable HTTP endpoint:

- **Endpoint URL:** `https://adhdbudget.bieda.it/mcp`
- **Authentication:** `Bearer <YOUR_MCP_TOKEN>` (or OAuth 2.1 authorization code flow)

### 4. Claude AI (Web)

1. Open Claude.ai → Account Settings → Connectors / Integrations → Add Custom Connector.
2. Enter the remote MCP endpoint URL:
   ```
   https://adhdbudget.bieda.it/mcp
   ```
3. Claude will discover the OAuth endpoints, perform Dynamic Client Registration, and complete the authorization code handshake.

---

## Local Development & Running

```bash
# Clone & navigate
git clone https://github.com/jakubkrzysztofsikora/adhd-budget.git
cd adhd-budget

# Configure environment (.env)
cp .env.example .env
# Fill in ENABLE_APP_ID, keys/enablebanking_private.pem, and MCP_TOKEN

# Start with Docker Compose
docker compose up -d

# Or run directly with Node.js
cd mcp-server
npm install
npm run build
npm start
```

### Run Tests

```bash
cd mcp-server
npm test
```

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

```bash
cd mcp-server
npm test
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  AI Clients (Claude AI, Claude Code, Kimi, Odysseus)        │
└──────────────┬──────────────────────────────┬───────────────┘
               │ OAuth 2.1 (Claude Web)       │ Bearer Token (CLI/Desktop/API)
               ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Reverse Proxy (Caddy with HTTPS)                           │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  ADHD Budget Gateway (Node.js 22 / TypeScript)              │
│                                                             │
│  • /connect Dashboard (Link PKO BP, Nest Bank, Revolut)     │
│  • Polish Pre-Aggregation (BLIK, Elixir, Deduplication)     │
│  • High-Value ADHD Tools (Snapshot, Leaks, Outliers, Bills) │
│  • SQLite Storage (WAL Mode, Zero external DBs)             │
└──────────────────────────────┬──────────────────────────────┘
                               │ PSD2 AIS (JWT RS256)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Enable Banking API (Restricted Production Tier)            │
│       ├──► PKO Bank Polski                                  │
│       ├──► Nest Bank                                        │
│       └──► Revolut                                          │
└─────────────────────────────────────────────────────────────┘
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