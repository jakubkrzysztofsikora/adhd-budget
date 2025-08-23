# Test Suite Audit Report

## Critical Issues Found

### 1. Mock Assertion Anti-Pattern
**Files**: `tests/unit/test_*.py`
- **Issue**: Tests import mock implementations from src and test against them
- **Example**: `TransactionCategorizer` in tests is the actual implementation being tested
- **Fix**: Tests should validate behavior, not implementation details

### 2. Missing Real Integration Tests
**Files**: `tests/integration/test_compose_boot.py`, `test_mcp_streaming.py`
- **Issue**: Tests use Docker client but don't actually start services
- **Issue**: MCP tests mock the server instead of testing real SSE through proxy
- **Fix**: Must test real docker-compose stack with actual services

### 3. E2E Tests Not End-to-End
**File**: `tests/e2e/test_enable_banking_flow.py`
- **Issue**: Uses mock Enable Banking client, not sandbox
- **Issue**: Doesn't test through full stack (proxy → API → DB)
- **Fix**: Use real sandbox with VCR recordings

### 4. Security Audits Incomplete
**Files**: `tests/shell/*.sh`
- **Issue**: Scripts have syntax errors (invalid grep patterns)
- **Issue**: Don't actually verify encryption at rest
- **Issue**: TLS checks bypass proxy layer
- **Fix**: Real security validation through deployed stack

### 5. Time-Based Flakiness
**File**: `tests/module/test_scheduler.py`
- **Issue**: Uses real time, not frozen
- **Issue**: Window checks could fail at boundary times
- **Fix**: Use freezegun or time injection

### 6. No Real Streaming Validation
- **Issue**: No test validates SSE through Caddy proxy
- **Issue**: Buffering behavior not tested
- **Fix**: Real streaming test with chunk timing validation

## Gate Coverage Analysis

| Gate | Current State | Issues | Required Fix |
|------|--------------|---------|--------------|
| T1 | ❌ Fake | No real compose boot | Real docker-compose with state validation |
| T2 | ❌ Mocked | No Enable Banking sandbox | Sandbox with VCR recordings |
| T3 | ⚠️ Partial | Tests own mocks | Golden file validation |
| T4 | ❌ Fake | No proxy streaming | Real SSE through Caddy |
| T5 | ❌ Flaky | Time-dependent | Frozen time control |
| S1 | ❌ Broken | Grep syntax errors | Fix shell scripts |
| S2 | ❌ Missing | No proxy TLS test | Real HTTPS validation |
| S3 | ❌ Stub | No encryption verify | Real auth & encryption |
| S4 | ⚠️ Partial | Only static checks | Runtime validation |

## Environment Dependencies (Undeclared)

1. `ENABLE_BANKING_APP_ID` - Required but not documented
2. `ENABLE_BANKING_CERT_PATH` - Required but not documented
3. `MCP_TOKEN` - Used inconsistently
4. `DB_PASSWORD` - Not properly managed
5. Docker daemon assumed running
6. Port 8080-8082 assumed available

## Test Categorization

### Keep (with fixes)
- None can be kept as-is

### Rewrite Required
- All integration tests
- All E2E tests
- All security audits

### New Tests Needed
1. Real docker-compose resilience test
2. Enable Banking sandbox integration with VCR
3. SSE streaming through proxy validation
4. TLS/HSTS verification through Caddy
5. Encrypted storage validation
6. Audit log verification

## Proposed Test Structure

```
tests/
├── unit/              # Pure functions only
│   └── golden/        # Golden test files
├── integration/       # Real service tests
│   ├── compose/       # Docker stack tests
│   ├── mcp/          # MCP through proxy
│   └── vcr/          # Recorded sessions
├── e2e/              # Full flow tests
│   └── scenarios/    # User journeys
├── security/         # Security validation
│   ├── runtime/      # Live checks
│   └── static/       # Code analysis
└── fixtures/         # Deterministic data
    └── seeds/        # Fixed random seeds
```
## 3. Test Improvements Made

### Fixed Tests
1. **T1 (test_t1_compose_resilience.py)**: Now tests real Docker Compose behavior
   - Real service startup validation
   - State persistence after restart
   - Automatic restart on failure
   - Network connectivity checks

2. **T4 (test_t4_mcp_streaming.py)**: Tests actual MCP through proxy with SSE
   - JSON-RPC 2.0 compliance
   - SSE streaming preservation
   - No WebSocket usage validation
   - Tool invocation through proxy

3. **T2 (test_t2_enable_banking_flow.py)**: E2E with VCR for Enable Banking
   - Sandbox authentication flow
   - Idempotent database upserts
   - Transaction deduplication
   - Re-consent flow handling

4. **T5 (test_t5_scheduler_deterministic.py)**: Uses frozen time for determinism
   - Window detection with frozen time
   - Run-once-daily validation
   - Summary payload completeness
   - WhatsApp format compliance

5. **S1 (test_s1_secrets_audit.sh)**: Fixed grep patterns and validation logic
   - Proper regex patterns for secrets
   - Git history scanning
   - Docker compose validation
   - .gitignore security entries

6. **S2 (test_s2_tls_validation.py)**: Real TLS and security header validation
   - TLS version requirements
   - Cipher strength validation
   - HSTS header enforcement
   - Certificate validation
   - SSE streaming preservation

7. **S3 (test_s3_access_control.py)**: Auth enforcement and security testing
   - API authentication requirements
   - Token expiry enforcement
   - SQL injection prevention
   - Path traversal blocking
   - CORS configuration

8. **S4 (test_s4_container_security.py)**: Runtime container security checks
   - Non-root user validation
   - Image digest pinning
   - Capability management
   - Resource limits
   - No privileged mode
   - Security options

## Remaining Work

1. Set up VCR cassette recordings for Enable Banking sandbox
2. Configure CI/CD pipeline with proper test ordering
3. Create golden test files for T3 intelligence validation
4. Implement load testing scenarios
5. Document environment variables and secrets management
