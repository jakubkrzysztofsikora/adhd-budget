# ADHD Budget Assistant - System Specification

## 1. Overview

### Problem Framing
The ADHD budgeting paradox: Manual reconciliation in Excel/YNAB consistently fails, leaving budgets perpetually outdated and creating more tracking burden than planning value. Without a living budget, households experience financial anxiety, money "leaks" through untracked spending, and savings remain inconsistent. The ADHD brain actively resists boring reconciliation tasks - this system must eliminate administrative work and surface only actionable decisions.

### Solution Goals
- **Auto-collection**: Automatically gather all household transactions from Revolut and Polish banks
- **Actionable Summaries**: Provide brief, decision-focused insights (not complex dashboards)
- **Household Alignment**: Create shared financial truth between spouses
- **AI Integration**: Leverage AI agents + MCP for planning, validation, and coaching
- **Trust Architecture**: Assume delivery by untrusted vendor - validate with strict automated gates before trust

## 2. System Scope (MVP+1)

### Services Architecture
All services run via Docker Compose on a Linux VPS:

```yaml
services:
  reverse-proxy:
    # Caddy/Traefik/Nginx with Let's Encrypt TLS, HSTS, SSE/streaming support
    
  mcp-server:
    # MCP JSON-RPC 2.0 over SSE or streamable HTTP (no WebSockets)
    
  worker:
    # - Pulls from Enable Banking API
    # - Idempotent transaction upserts
    # - Categorization engine
    # - Projections calculator
    # - Outlier analysis
    # - Daily summary job scheduler
    
  db:
    # Postgres or DuckDB with encrypted volume
    
  api:
    # Health endpoints + WhatsApp webhook integration
    
  redis:
    # Optional: queues/scheduling
```

### Daily WhatsApp Summary
Delivered via WhatsApp Business Cloud API (dedicated number):
- Yesterday's spending totals
- Category breakdown (groceries, eating out, etc.)
- Budget vs actual comparison
- Pace projection (extrapolated monthly spend based on yesterday)
- Month-end balance impact projection
- Outlier flagging (lease, large one-offs) with adjusted "without-outliers" pace

### MCP Integration
Claude Desktop/Web Connectors consume these tools via OAuth-authenticated MCP server:
- `summary.today` - Current day's financial summary
- `projection.month` - Monthly spending projections
- `transactions.query` - Query transactions with date filtering
- `search` - Free-text search over recent transactions (required by ChatGPT Developer Mode)
- `fetch` - Retrieve a specific transaction payload
- `accounts.list` - List connected bank accounts
- `spending.categorize` - ML-powered transaction categorization
- `budget.status` - Budget vs actual comparison
- `outliers.detect` - Find unusual transactions
- `savings.forecast` - Project savings potential

**Authentication**: OAuth 2.1 flow (authorization code + refresh token) with JWT-backed Enable Banking API access

### Connector configuration
- **Claude Desktop/Web (remote)**: Point Claude to your HTTPS deployment (for example `https://mcp.example.com`). Claude fetches `/.well-known/mcp.json` (respecting forwarded headers), registers a client with the appropriate redirect variant, and walks through OAuth automatically with a direct 302 back to Claude.
- **Claude Desktop (local relay)**: During development you can still rely on `npx mcp-remote http://127.0.0.1:8000/mcp` to expose the streamable HTTP endpoint locally.
- **ChatGPT Developer Mode**: Settings → Connectors → Advanced → Developer Mode → Add your HTTPS endpoint (or `http://127.0.0.1:8000/mcp` for local testing). The MCP server recognises the full set of ChatGPT redirects (see `DEFAULT_REMOTE_REDIRECT_URIS`) and sends a direct 302 back to the requested callback, eliminating the "invalid redirect" error.

## 3. Iterative Roadmap

### Iteration 1 (MVP+1) - CURRENT STATUS
- ✅ Enable Banking OAuth integration (using real API, not mock)
- ✅ MCP server with 8 financial tools
- ✅ OAuth discovery and dynamic client registration (RFC 8414/7591)
- ✅ Session-based authentication (Enable Banking session ID as token)
- ✅ Docker Compose deployment with Caddy reverse proxy
- 🚧 Daily WhatsApp summary with projections + outlier detection

### Iteration 2
- Polish bank integration
- Planner agent for recurring bills
- Category-specific goals

### Iteration 3
- Household dashboard
- Weekly "family CFO" reports
- Coaching agent activation

### Iteration 4+
- Mood-based spending nudges
- Wearable device integration
- Long-term savings forecasts

**Critical Rule**: No expansion until all validation gates pass for 14 consecutive days.

## 4. Model Context Protocol (MCP) Standards

### Official MCP Specification
Always follow the latest MCP specification: https://modelcontextprotocol.io/specification

### Core Requirements
- **Protocol Version**: 2025-06-18
- **Transport**: Streamable HTTP with SSE support
- **Message Format**: JSON-RPC 2.0
- **Required Methods**:
  - `initialize` - Protocol version negotiation and capability exchange
  - `initialized` - Confirmation of initialization
  - `tools/list` - List available tools
  - `tools/call` - Execute tool
  - `resources/list` - List available resources (optional)
  - `prompts/list` - List available prompts (optional)
  - `ping` - Keep-alive mechanism

### SSE Transport Requirements
- Single `/mcp` endpoint handles POST (JSON-RPC) and GET (SSE stream)
- HTTP POST for sending messages
- HTTP GET with SSE for receiving streaming responses
- Messages must be UTF-8 encoded JSON-RPC
- Newline-delimited messages (no embedded newlines)
- Support multiple simultaneous SSE streams
- Include `MCP-Protocol-Version` header
- Validate `Origin` header for security
- `Mcp-Session-Id` header required on non-initialize requests

### Authentication
- Bearer token authentication (current implementation)
- OAuth 2.1 support (recommended for production)

## 5. Validation Framework

### Technical Gates (T)

| Gate | Description | Validation Criteria |
|------|-------------|-------------------|
| T1 | Compose boot & resilience | `docker compose up -d` succeeds, healthchecks pass, auto-restart functional |
| T2 | Data flow integrity | Enable Banking → DB pipeline works, idempotent upserts verified, re-consent tested |
| T3 | Intelligence accuracy | Categorization ≥80% accurate, projections ±5% error, outliers <10% false positives |
| T4 | MCP compliance | Remote MCP spec-compliant over SSE/HTTP, JSON-RPC 2.0 valid, tools list/invoke correctly |
| T5 | Job scheduling | Daily summary runs once between 08:00-08:10 with all required fields |

### Security Gates (S)

| Gate | Description | Validation Criteria |
|------|-------------|-------------------|
| S1 | Secrets management | No secrets in git, OAuth only, secrets via Docker secrets/env |
| S2 | TLS implementation | Let's Encrypt active, HSTS enabled, streaming preserved, SSL Labs A rating |
| S3 | Access control | Data encrypted at rest, MCP/API token/mTLS required, 401/403 on unauthorized, audit logs |
| S4 | Container hardening | Non-root containers, images pinned by digest, capabilities dropped, resource limits |

### Usability Gates (U)

| Gate | Description | Validation Criteria |
|------|-------------|-------------------|
| U1 | Summary clarity | ≤6 lines, plain language, both spouses read ≥4/5 weekdays |
| U2 | Behavioral impact | After 2-3 weeks: anxiety reduced, ≥1 decision/week based on summary |

### Infrastructure/Operability Gates (I)

| Gate | Description | Validation Criteria |
|------|-------------|-------------------|
| I1 | Observability | Logs aggregated, health endpoints functional, alert on 2 consecutive failures |
| I2 | Disaster recovery | Nightly encrypted DB backups, tested restore <30 min |
| I3 | Public accessibility | HTTPS endpoint reachable, Claude connector integration passes |

### Messaging Gates (M)

| Gate | Description | Validation Criteria |
|------|-------------|-------------------|
| M1 | WhatsApp integration | Business Cloud API connected, dedicated number active, webhook functional, daily job posts |

**Note**: iMessage personal bots not viable; Messages for Business requires Apple enterprise onboarding.

## 5. Security & Privacy Principles

- **Never** store raw bank credentials
- OAuth-only authentication flows
- Zero secrets in version control
- Data restricted to private VPS/database
- TLS encryption everywhere
- Comprehensive logs + audit trails mandatory

## 6. Developer Onboarding

### Quick Start
```bash
# Clone and launch
git clone [repo]
docker compose up -d

# Verify health
curl http://localhost/healthz

# Run test suite
make test  # Runs unit/module/integration/e2e/shell audits

# CI/CD
# GitHub Actions runs all gates nightly
# Produces compliance matrix dashboard
```

### Adding MCP Tools
1. Implement tool logic
2. Register in MCP server
3. Expose via JSON-RPC interface
4. Write comprehensive tests
5. Re-run compliance suite

### WhatsApp Setup
1. Configure Cloud API sandbox
2. Point webhook to api service
3. Verify round-trip messaging

### Claude Integration
1. Add remote MCP server in Claude Desktop/Web connectors
2. Verify tool discovery
3. Test tool invocation

## 7. ADHD/UX Philosophy

### Core Principles
- **Reduce cognitive load**: Daily summary in chat format, not complex dashboards
- **Brevity**: ≤6 lines focusing on "so what" (pace vs budget, balance impact)
- **Context**: Outliers explained to prevent panic (e.g., "lease day spike is normal")
- **Household alignment**: Single source of truth reduces arguments, increases alignment

### Design Decisions
- Push notifications over pull dashboards
- Decisions over data
- Trends over transactions
- Exceptions over exhaustive lists

## 8. Future Expansion Ideas

- Weekly AI coaching sessions
- Goal-based savings forecasts
- Stress-spending alerts via wearables
- Notion/dashboard integrations
- Spending pattern ML models
- Bill negotiation agent
- Investment readiness scoring

## 9. Compliance Matrix Template

| Gate | Description | Test/Script | Status | Evidence |
|------|-------------|-------------|--------|----------|
| T1 | Compose boot & resilience | `tests/integration/test_compose.py` | ⬜ | ⬜ |
| T2 | Data flow, upserts, re-consent | `tests/e2e/test_data_flow.py` | ⬜ | ⬜ |
| T3 | Intelligence accuracy | `tests/ml/test_categorization.py` | ⬜ | ⬜ |
| T4 | MCP compliance | `tests/mcp/test_protocol.py` | ⬜ | ⬜ |
| T5 | Job scheduling | `tests/cron/test_daily_summary.py` | ⬜ | ⬜ |
| S1 | Secrets management | `tests/security/test_secrets.sh` | ⬜ | ⬜ |
| S2 | TLS implementation | `tests/security/test_tls.py` | ⬜ | ⬜ |
| S3 | Access control | `tests/security/test_auth.py` | ⬜ | ⬜ |
| S4 | Container hardening | `tests/security/test_containers.sh` | ⬜ | ⬜ |
| U1 | Summary clarity | `tests/ux/test_summary_format.py` | ⬜ | ⬜ |
| U2 | Behavioral impact | `manual/user_survey.md` | ⬜ | ⬜ |
| I1 | Observability | `tests/infra/test_monitoring.py` | ⬜ | ⬜ |
| I2 | Disaster recovery | `tests/infra/test_backup_restore.sh` | ⬜ | ⬜ |
| I3 | Public accessibility | `tests/e2e/test_public_endpoint.py` | ⬜ | ⬜ |
| M1 | WhatsApp integration | `tests/messaging/test_whatsapp.py` | ⬜ | ⬜ |

## 10. Technical Specifications

### Database Schema (Core Tables)
```sql
-- Transactions
CREATE TABLE transactions (
    id UUID PRIMARY KEY,
    account_id VARCHAR(255),
    amount DECIMAL(10,2),
    currency VARCHAR(3),
    category VARCHAR(100),
    merchant VARCHAR(255),
    transaction_date DATE,
    description TEXT,
    is_outlier BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- Daily Summaries
CREATE TABLE daily_summaries (
    id UUID PRIMARY KEY,
    summary_date DATE UNIQUE,
    total_spent DECIMAL(10,2),
    category_breakdown JSONB,
    pace_projection DECIMAL(10,2),
    outlier_adjusted_pace DECIMAL(10,2),
    projected_balance DECIMAL(10,2),
    sent_at TIMESTAMP,
    created_at TIMESTAMP
);

-- Budget Goals
CREATE TABLE budget_goals (
    id UUID PRIMARY KEY,
    category VARCHAR(100),
    monthly_limit DECIMAL(10,2),
    priority INTEGER,
    active BOOLEAN DEFAULT TRUE
);
```

### MCP Protocol Example
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

### WhatsApp Message Template
```
💰 Yesterday's Summary (Jan 22)
Spent: £127.43
• Groceries: £45.20
• Eating out: £32.23
• Transport: £50.00
Pace: £3,823/mo (vs £3,500 budget)
Impact: -£323 by month end
```

## 11. Testing Protocol

### Overview
This protocol MUST be executed after each change, feature addition, or bugfix. It validates all Technical (T) and Security (S) gates to ensure system integrity.

### Pre-Commit Testing (Local)

```bash
# 1. Security validation - MUST PASS before commit
./tests/shell/scan_git_secrets.sh      # S1: No secrets in code
./tests/shell/check_compose_security.sh # S4: Container security

# 2. Unit tests (runs locally)
python3 -m pytest tests/unit/ -v

# 3. Integration tests (MUST run in container for proper networking)
DB_PASSWORD=testdupa123! docker compose up -d
DB_PASSWORD=testdupa123! docker compose run --rm test-runner pytest tests/integration/ -v

# Or run specific test suites:
DB_PASSWORD=testdupa123! docker compose run --rm test-runner pytest tests/integration/test_t1_compose_resilience.py -v
DB_PASSWORD=testdupa123! docker compose run --rm test-runner pytest tests/integration/test_t4_mcp_streaming.py -v
DB_PASSWORD=testdupa123! docker compose run --rm test-runner pytest tests/integration/test_oauth_pkce.py -v
```

### CI/CD Pipeline (GitHub Actions)

Automatically runs on every push to main:

1. **Security Gates:**
   - S1: Secrets hygiene (`scan_git_secrets.sh`)
   - S4: Container security (`check_compose_security.sh`)

2. **Technical Gates:**
   - T1/T4: Docker Compose & MCP integration
   - T2/T5: Data flow & scheduling  
   - T3: Unit tests (Python 3.9, 3.10, 3.11)

3. **Deployment (main branch only):**
   - Archives source files
   - Transfers to VPS via SSH
   - Builds Docker images on VPS
   - Deploys with production environment variables

### Post-Deployment Testing

```bash
# 1. E2E tests against production
python3 tests/e2e/test_deployed_instance.py

# 2. MCP Inspector testing
./setup_mcp_inspector.sh
# Opens at http://localhost:6274
# Test with Bearer token: test_mcp_token_secure_2024

# 3. API health check
curl -H "Authorization: Bearer $API_TOKEN" https://adhdbudget.bieda.it/api/health

# 4. Production monitoring
curl https://adhdbudget.bieda.it/health
```

### Authentication Notes

- **MCP Server:** Uses Bearer token authentication (not OAuth)
- **Enable Banking:** Uses OAuth 2.0 with JWT (RS256)
- **API:** Bearer token authentication
- **Production tokens:** Stored as GitHub secrets

### Gate-Specific Tests

#### T1: Compose Boot & Resilience
```bash
pytest tests/integration/test_compose_boot.py -v
```

#### T2: Data Flow Integrity
```bash
pytest tests/module/test_db_upserts.py -v
```

#### T3: Intelligence Accuracy
```bash
pytest tests/unit/test_categorization.py -v
pytest tests/unit/test_projections.py -v
pytest tests/unit/test_outliers.py -v
```

#### T4: MCP Compliance
```bash
pytest tests/integration/test_mcp_streaming.py -v
```

#### T5: Job Scheduling
```bash
pytest tests/module/test_scheduler.py -v
```

#### S1: Secrets Hygiene
```bash
./tests/shell/scan_git_secrets.sh
```

#### S2: TLS & Headers
```bash
./tests/shell/check_proxy_tls_headers.sh
```

#### S3: Access Control
```bash
pytest tests/integration/test_auth.py -v
```

#### S4: Container Security
```bash
./tests/shell/check_compose_security.sh
```

### Acceptance Criteria

All gates must achieve these thresholds:
- **T1**: All services start, healthchecks pass, restart works
- **T2**: Zero duplicate transactions, idempotent operations
- **T3**: ≥80% categorization, ±5% projections, <10% outlier FP
- **T4**: JSON-RPC 2.0 compliant, SSE streaming functional
- **T5**: Job runs once daily in 08:00-08:10 window
- **S1**: Zero secrets in git history
- **S2**: HSTS enabled, SSL Labs Grade A
- **S3**: All endpoints require auth, audit logs present
- **S4**: Non-root containers, pinned images, resource limits

### CI/CD Pipeline

GitHub Actions automatically runs on:
- Every push to main/develop
- Every pull request
- Nightly at 2 AM UTC

```bash
# Run CI locally
make ci-test
```

### 14-Day Validation

Track consecutive passing days:
```bash
# View compliance history
cat reports/compliance-matrix.md | grep "Consecutive Pass Days"
```

### Quick Fixes

If tests fail:
1. Check specific gate output
2. Fix the issue
3. Re-run ONLY that gate's test
4. Once passing, run full protocol
5. Commit only after all gates pass

### Test Coverage Requirements

Maintain minimum coverage:
- Unit tests: 80%
- Integration tests: 60%
- E2E tests: 40%

```bash
# Check coverage
make coverage
```

## 12. Development Constraints

### CRITICAL DEVELOPMENT RULES
1. **NEVER CREATE SLOP** - Do not create duplicate or "fixed" versions of existing files
2. **NEVER** create script_fixed.sh when script.sh exists - fix the original
3. **NEVER** create additional files when an existing file can be modified
4. Only create NEW files when there is NO existing similar file that can be changed
5. Always prefer editing existing files over creating new ones
6. **NEVER USE continue-on-error** - Fix the actual problems, don't hide them
7. **NO CHEATING** - If a test fails, fix the root cause, don't skip or ignore it

### File Creation Policy
- **DO NOT** create additional shell scripts unless explicitly requested
- **DO NOT** create additional markdown files unless explicitly requested
- **DO NOT** create documentation files proactively
- Only create files when the user specifically asks for them

### Testing Requirements
- Run the full Testing Protocol after EVERY change
- No commits without passing gates
- Document failures in compliance matrix
- Check the yml file, make sure the scripts being run there pass before commiting and pushing
- **MONITOR DEPLOYMENT**: After EVERY push to main, monitor the GitHub Actions pipeline until completion:
  ```bash
  # Check deployment status
  curl -s "https://api.github.com/repos/jakubkrzysztofsikora/adhd-budget/actions/runs?per_page=1" | jq '.workflow_runs[0] | {status, conclusion}'
  
  # Or check via web
  https://github.com/jakubkrzysztofsikora/adhd-budget/actions
  ```

## 13. Enable Banking Setup

### Sandbox Registration (Required for Development)
1. Register at https://enablebanking.com for a sandbox account
2. Create an application in the Enable Banking dashboard
3. Generate RSA key pair for JWT signing:
   ```bash
   # Generate private key
   openssl genrsa -out keys/enablebanking_private.pem 2048
   
   # Extract public key
   openssl rsa -in keys/enablebanking_private.pem -pubout -out keys/enablebanking_public.pem
   ```
4. Upload the public key to Enable Banking dashboard
5. Update `.env` with your credentials:
   - `ENABLE_APP_ID`: Your application ID from Enable Banking
   - `ENABLE_PRIVATE_KEY_PATH`: Path to your private key
   - `ENABLE_API_BASE_URL`: https://api.enablebanking.com

### Authentication Flow
Enable Banking uses JWT-based authentication with RS256 signing:
- All API calls require JWT in Authorization header
- OAuth /auth/authorize endpoint also requires JWT authentication
- JWT must include: iss="enablebanking.com", aud="api.enablebanking.com", kid=app_id
- Access tokens are obtained via OAuth authorization code flow after JWT auth

### Important Notes
- **NO MOCK OAuth**: Always use real Enable Banking API, even in development
- Sandbox credentials provide full API access with test data
- JWT authentication is required for ALL endpoints, including OAuth
- MCP Inspector OAuth flow requires proper Enable Banking sandbox registration

## 14. Deployment Checklist

- [ ] VPS provisioned with Docker/Compose
- [ ] Domain configured with DNS
- [ ] Enable Banking sandbox account registered
- [ ] Enable Banking application created with RSA keys
- [ ] WhatsApp Business account created
- [ ] SSL certificates auto-renewing
- [ ] Backup strategy implemented
- [ ] Monitoring/alerting configured
- [ ] MCP server accessible
- [ ] Claude connector tested
- [ ] All validation gates green
- [ ] 14-day stability period completed

---

*This specification serves as the single source of truth for the ADHD Budget Assistant project. All implementation decisions should align with these requirements and philosophies.*