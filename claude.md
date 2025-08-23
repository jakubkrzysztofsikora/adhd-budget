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
Claude Desktop/Web Connectors consume these tools:
- `summary.today` - Current day's financial summary
- `projection.month` - Monthly spending projections
- `transactions.query?since=ISO` - Query transactions with date filtering

## 3. Iterative Roadmap

### Iteration 1 (MVP+1)
- Revolut integration only
- Daily WhatsApp summary with projections + outlier detection

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

## 4. Validation Framework

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

### Full Testing Sequence

```bash
# 1. Quick validation (30 seconds)
make validate-gates

# 2. Unit tests - T3 gates (1 minute)
make test-unit

# 3. Security audits - S1, S2, S4 gates (2 minutes)
make audit-secrets
make audit-compose
make audit-tls

# 4. Integration tests - T1, T4 gates (3 minutes, requires Docker)
make test-integration

# 5. Module tests - T2, T5 gates (2 minutes)
make test-module

# 6. End-to-end tests (5 minutes, requires full stack)
make test-e2e

# 7. Generate compliance report
make compliance-check

# 8. Full test suite (includes all above)
make test
```

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

## 13. Deployment Checklist

- [ ] VPS provisioned with Docker/Compose
- [ ] Domain configured with DNS
- [ ] Enable Banking API credentials obtained
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