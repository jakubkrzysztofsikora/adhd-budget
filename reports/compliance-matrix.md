# T&S Gates Compliance Matrix

**System**: ADHD Budget Assistant MVP+1  
**Generated**: [DATE]  
**Test Run**: [RUN_ID]

## Executive Summary

This compliance matrix tracks the validation status of all Technical (T) and Security (S) gates required for the fishy vendor verification. Each gate must pass for 14 consecutive days before system expansion.

## Gate Status Overview

| Gate | Category | Description | Status | Last Test | Evidence | Notes |
|------|----------|-------------|--------|-----------|----------|-------|
| **T1** | Technical | Compose boot & resilience | ⬜ | - | `tests/integration/test_compose_boot.py` | Docker compose up -d, healthchecks, auto-restart |
| **T2** | Technical | Data flow integrity | ⬜ | - | `tests/module/test_db_upserts.py` | Enable Banking → DB, idempotent upserts, re-consent |
| **T3** | Technical | Intelligence accuracy | ⬜ | - | `tests/unit/test_*.py` | Categorization ≥80%, projections ±5%, outliers <10% FP |
| **T4** | Technical | MCP compliance | ⬜ | - | `tests/integration/test_mcp_streaming.py` | JSON-RPC 2.0 over SSE/HTTP, tools exposed, streaming |
| **T5** | Technical | Job scheduling | ⬜ | - | `tests/module/test_scheduler.py` | Daily summary 08:00-08:10, required fields present |
| **S1** | Security | Secrets hygiene | ⬜ | - | `tests/shell/scan_git_secrets.sh` | No secrets in git, OAuth only, Docker secrets |
| **S2** | Security | TLS & headers | ⬜ | - | `tests/shell/check_proxy_tls_headers.sh` | Let's Encrypt, HSTS, SSL Labs Grade A, streaming |
| **S3** | Security | Access control | ⬜ | - | `tests/integration/test_auth.py` | Encrypted at rest, token/mTLS required, audit logs |
| **S4** | Security | Container security | ⬜ | - | `tests/shell/check_compose_security.sh` | Non-root, pinned digests, capabilities, limits |

**Legend**: ✅ Passed | ❌ Failed | ⬜ Not Tested | ⚠️ Partial Pass | 🔄 In Progress

## Detailed Test Results

### T1: Compose Boot & Resilience
```
Test File: tests/integration/test_compose_boot.py
Last Run: [TIMESTAMP]
Status: [STATUS]

Sub-tests:
[ ] docker compose up -d succeeds
[ ] All services have healthchecks
[ ] Restart policy is 'unless-stopped'
[ ] Container restart after failure works
[ ] State preserved after cold reboot
[ ] Service dependencies respected
[ ] Network connectivity verified

Failures:
- [List any failures]

Evidence:
- Docker logs: reports/docker-compose-T1.log
- Test output: reports/T1-results.xml
```

### T2: Data Flow Integrity
```
Test File: tests/module/test_db_upserts.py
Last Run: [TIMESTAMP]
Status: [STATUS]

Sub-tests:
[ ] Enable Banking fetch succeeds
[ ] Idempotent upserts (no duplicates)
[ ] Re-consent flow exercised
[ ] Transaction integrity maintained
[ ] Batch processing works
[ ] Error recovery functional

Failures:
- [List any failures]

Evidence:
- DB query logs: reports/db-T2.log
- Test output: reports/T2-results.xml
```

### T3: Intelligence Accuracy
```
Test Files: tests/unit/test_categorization.py, test_projections.py, test_outliers.py
Last Run: [TIMESTAMP]
Status: [STATUS]

Metrics:
- Categorization Accuracy: [X]% (Required: ≥80%)
- Projection Error: ±[X]% (Required: ≤5%)
- Outlier False Positives: [X]% (Required: <10%)

Sub-tests:
[ ] Categorization accuracy ≥80%
[ ] Monthly pace projection ±5%
[ ] Month-end balance projection ±5%
[ ] Outlier detection <10% false positives
[ ] Adjusted pace calculation correct
[ ] Edge cases handled

Failures:
- [List any failures]

Evidence:
- Accuracy report: reports/T3-accuracy.json
- Test output: reports/T3-results.xml
```

### T4: MCP Compliance
```
Test File: tests/integration/test_mcp_streaming.py
Last Run: [TIMESTAMP]
Status: [STATUS]

Sub-tests:
[ ] JSON-RPC 2.0 compliant
[ ] Tools exposed: summary.today, projection.month, transactions.query
[ ] SSE streaming works
[ ] No WebSocket usage
[ ] Long-running calls don't deadlock
[ ] Malformed requests return spec errors
[ ] Concurrent requests handled

Failures:
- [List any failures]

Evidence:
- MCP protocol trace: reports/mcp-T4.json
- Test output: reports/T4-results.xml
```

### T5: Job Scheduling
```
Test File: tests/module/test_scheduler.py
Last Run: [TIMESTAMP]
Status: [STATUS]

Sub-tests:
[ ] Daily job runs once only
[ ] Executes between 08:00-08:10
[ ] Payload contains all fields
[ ] Totals calculated correctly
[ ] Vs-budget comparison present
[ ] Pace projection included
[ ] Outliers identified
[ ] Adjusted pace calculated

Failures:
- [List any failures]

Evidence:
- Scheduler logs: reports/scheduler-T5.log
- Test output: reports/T5-results.xml
```

### S1: Secrets Hygiene
```
Test File: tests/shell/scan_git_secrets.sh
Last Run: [TIMESTAMP]
Status: [STATUS]

Sub-tests:
[ ] No secrets in git history
[ ] No .env files committed
[ ] .gitignore has security entries
[ ] Docker compose uses secrets/env_file
[ ] No hardcoded passwords
[ ] OAuth tokens not exposed

Tools Used:
- TruffleHog: [VERSION]
- GitLeaks: [VERSION]
- Custom patterns: [COUNT] patterns

Failures:
- [List any findings]

Evidence:
- Scan report: reports/secrets-S1.json
- Test output: reports/S1-results.txt
```

### S2: TLS & Security Headers
```
Test File: tests/shell/check_proxy_tls_headers.sh
Last Run: [TIMESTAMP]
Status: [STATUS]

Sub-tests:
[ ] HTTPS enforced
[ ] TLS 1.2+ only
[ ] Strong ciphers only
[ ] HSTS header present
[ ] HSTS max-age ≥31536000
[ ] Certificate valid
[ ] Let's Encrypt issuer
[ ] SSE streaming preserved
[ ] Security headers present

SSL Labs Grade: [GRADE]
Certificate Expiry: [DATE]

Failures:
- [List any failures]

Evidence:
- SSL scan: reports/ssl-S2.json
- Headers dump: reports/headers-S2.txt
- Test output: reports/S2-results.txt
```

### S3: Access Control
```
Test File: tests/integration/test_auth.py
Last Run: [TIMESTAMP]
Status: [STATUS]

Sub-tests:
[ ] Data encrypted at rest
[ ] MCP requires token/mTLS
[ ] API requires authentication
[ ] Unauthorized returns 401/403
[ ] Audit logs created
[ ] Log retention policy enforced
[ ] RBAC implemented
[ ] Session management secure

Failures:
- [List any failures]

Evidence:
- Auth test logs: reports/auth-S3.log
- Test output: reports/S3-results.xml
```

### S4: Container Security
```
Test File: tests/shell/check_compose_security.sh
Last Run: [TIMESTAMP]
Status: [STATUS]

Sub-tests:
[ ] All containers run non-root
[ ] Images pinned by SHA256 digest
[ ] Capabilities dropped (CAP_DROP)
[ ] Resource limits set
[ ] No privileged mode
[ ] Read-only filesystem where applicable
[ ] Security options configured
[ ] Dockerfiles have USER instruction

Container Analysis:
- Total containers: [COUNT]
- Non-root: [COUNT]
- Pinned: [COUNT]
- Limited: [COUNT]

Failures:
- [List any failures]

Evidence:
- Container audit: reports/containers-S4.json
- Test output: reports/S4-results.txt
```

## Historical Trends

### 14-Day Validation Period

| Day | Date | T1 | T2 | T3 | T4 | T5 | S1 | S2 | S3 | S4 | All Pass |
|-----|------|----|----|----|----|----|----|----|----|-------|---------|
| 1   | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 2   | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 3   | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 4   | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 5   | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 6   | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 7   | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 8   | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 9   | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 10  | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 11  | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 12  | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 13  | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |
| 14  | -    | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ❌ |

**Consecutive Pass Days**: 0 / 14 required

## Action Items

### Critical Issues (Must Fix)
1. [Issue description] - Gate: [GATE] - Priority: HIGH
2. [Issue description] - Gate: [GATE] - Priority: HIGH

### Warnings (Should Fix)
1. [Warning description] - Gate: [GATE] - Priority: MEDIUM
2. [Warning description] - Gate: [GATE] - Priority: MEDIUM

### Recommendations (Nice to Have)
1. [Recommendation] - Gate: [GATE] - Priority: LOW
2. [Recommendation] - Gate: [GATE] - Priority: LOW

## Manual Verification Steps

Some gates require manual verification in production:

### S2: SSL Labs Test
```bash
# Visit: https://www.ssllabs.com/ssltest/
# Enter your domain: [PRODUCTION_URL]
# Target grade: A or A+
# Record results in this matrix
```

### S3: Penetration Testing
```bash
# Run OWASP ZAP or similar
# Document findings
# Verify auth bypass attempts fail
```

## Automation Status

| Test Type | Automated | Coverage | Notes |
|-----------|-----------|----------|-------|
| Unit Tests | ✅ | 80% | pytest with coverage |
| Integration | ✅ | 60% | Docker-based tests |
| E2E Tests | ⚠️ | 40% | Partial automation |
| Security Scans | ✅ | 90% | TruffleHog, GitLeaks, Trivy |
| Performance | ❌ | 0% | Manual testing required |
| Accessibility | ❌ | 0% | Not applicable (API only) |

## Next Steps

1. **Immediate**: Fix all critical issues blocking gates
2. **This Week**: Achieve first full green run
3. **This Month**: Complete 14-day validation period
4. **Next Month**: Expand to Iteration 2 features

## Appendix

### Test Commands

```bash
# Run all gates
make test

# Run specific gate
make test-unit      # T3
make audit-secrets  # S1
make audit-compose  # S4

# Generate this report
make compliance-check

# CI/CD pipeline
make ci-test
```

### File Locations

- Test Suites: `/tests/`
- Shell Scripts: `/tests/shell/`
- Reports: `/reports/`
- Coverage: `/coverage/`
- CI Config: `/.github/workflows/verify.yml`

### Contact

- QA Lead: [Name]
- Security Lead: [Name]
- DevOps Lead: [Name]

---

*This matrix is automatically generated. Do not edit manually. Update via test results only.*