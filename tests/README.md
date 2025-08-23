# ADHD Budget Assistant - Test Harness Documentation

## Overview

This test harness implements comprehensive validation for the ADHD Budget Assistant MVP+1 system, ensuring compliance with Technical (T1-T5) and Security (S1-S4) gates. The system follows a "fishy vendor" verification approach, requiring all gates to pass for 14 consecutive days before trust is established.

## Quick Start

```bash
# Install dependencies
make install

# Run all tests
make test

# Run specific gate tests
make test-unit        # T3: Intelligence accuracy
make audit-secrets    # S1: Secrets scanning
make audit-compose    # S4: Container security

# Generate compliance report
make compliance-check
```

## Gate Coverage

### Technical Gates (T)

| Gate | Description | Test Location | Requirements |
|------|-------------|---------------|--------------|
| **T1** | Compose boot & resilience | `integration/test_compose_boot.py` | Docker services start, healthchecks pass, auto-restart works |
| **T2** | Data flow integrity | `module/test_db_upserts.py` | Idempotent upserts, no duplicates, re-consent flow |
| **T3** | Intelligence accuracy | `unit/test_*.py` | Categorization ≥80%, projections ±5%, outliers <10% FP |
| **T4** | MCP compliance | `integration/test_mcp_streaming.py` | JSON-RPC 2.0 over SSE/HTTP, no WebSockets |
| **T5** | Job scheduling | `module/test_scheduler.py` | Daily summary 08:00-08:10, all fields present |

### Security Gates (S)

| Gate | Description | Test Location | Requirements |
|------|-------------|---------------|--------------|
| **S1** | Secrets hygiene | `shell/scan_git_secrets.sh` | No secrets in git, OAuth only |
| **S2** | TLS & headers | `shell/check_proxy_tls_headers.sh` | HTTPS, HSTS, SSL Labs Grade A |
| **S3** | Access control | `integration/test_auth.py` | Encrypted data, token/mTLS required |
| **S4** | Container security | `shell/check_compose_security.sh` | Non-root, pinned digests, resource limits |

## Test Structure

```
tests/
├── unit/                   # Pure logic tests (T3)
│   ├── test_categorization.py
│   ├── test_projections.py
│   └── test_outliers.py
├── module/                 # Component tests (T2, T5)
│   ├── test_db_upserts.py
│   ├── test_scheduler.py
│   └── test_oauth_refresh.py
├── integration/            # Stack tests (T1, T4)
│   ├── test_compose_boot.py
│   ├── test_healthchecks.py
│   ├── test_mcp_streaming.py
│   └── test_proxy_streaming.py
├── e2e/                    # End-to-end scenarios
│   ├── test_cold_start_flow.py
│   ├── test_duplicate_prevention.py
│   ├── test_mcp_error_handling.py
│   └── test_reconsent_flow.py
├── shell/                  # Security audits (S1, S2, S4)
│   ├── scan_git_secrets.sh
│   ├── check_compose_security.sh
│   ├── check_proxy_tls_headers.sh
│   ├── verify_streaming.sh
│   └── ssl_grade_stub.sh
├── fixtures/               # Test data
│   ├── transactions.json
│   ├── synthetic_14day.json
│   └── oauth_mocks.json
└── utils/                  # Test helpers
    ├── mcp_test_client.py
    ├── time_travel.py
    └── docker_helpers.py
```

## Running Tests

### Local Development

```bash
# Start services
make up

# Run specific test suites
pytest tests/unit/ -v                    # Unit tests only
pytest tests/integration/ -v             # Integration tests
pytest tests/e2e/ -v                     # End-to-end tests

# Run security audits
./tests/shell/scan_git_secrets.sh        # Secret scanning
./tests/shell/check_compose_security.sh  # Container audit
./tests/shell/check_proxy_tls_headers.sh # TLS verification

# Stop services
make down
```

### CI/CD Pipeline

Tests run automatically on:
- Every push to `main` or `develop`
- Every pull request
- Nightly at 2 AM UTC
- Manual workflow dispatch

```yaml
# GitHub Actions workflow: .github/workflows/verify.yml
- Secrets scanning (TruffleHog, GitLeaks)
- Unit tests (Python matrix: 3.9, 3.10, 3.11)
- Container security (Hadolint, Trivy)
- Integration tests (Docker-in-Docker)
- Compliance matrix generation
```

### Environment Variables

```bash
# Test configuration
export SKIP_CERT_CHECK=true       # Skip TLS cert validation (dev)
export PROXY_URL=https://localhost # Proxy endpoint
export FAKE_TIME="2024-01-15 08:05:00" # Time travel for T5
export DEBUG_TESTS=true           # Verbose test output
```

## Test Data

### Fixtures

- **transactions.json**: 30 labeled transactions for categorization testing
- **synthetic_14day.json**: 14-day dataset with known outliers and projections
- **oauth_mocks.json**: Mock OAuth responses for Enable Banking simulation

### Creating Test Data

```python
# Generate new test transactions
from tests.utils.data_generator import generate_transactions

transactions = generate_transactions(
    count=100,
    include_outliers=True,
    categories=['groceries', 'transport', 'eating_out']
)
```

## Gate-Specific Testing

### T3: Intelligence Accuracy

```bash
# Run categorization tests
pytest tests/unit/test_categorization.py -v

# Expected output:
# Categorization Accuracy: 85.2% (26/30 correct) ✓
# Projection Error: ±3.2% ✓
# Outlier False Positives: 7.1% ✓
```

### S1: Secrets Scanning

```bash
# Run comprehensive secret scan
make audit-secrets

# Tools used (in order of preference):
1. TruffleHog (if installed)
2. GitLeaks (if installed)  
3. git-secrets (if installed)
4. Grep patterns (fallback)
```

### T4: MCP Compliance

```python
# Test MCP server manually
from tests.utils.mcp_test_client import MCPTestClient

async with MCPTestClient("http://localhost:8080/mcp") as client:
    # List available tools
    tools = await client.send_jsonrpc("tools/list")
    
    # Call a tool
    result = await client.send_jsonrpc(
        "tools/call",
        {"name": "summary.today", "arguments": {}}
    )
    
    # Test streaming
    async for chunk in client.stream_sse("summary.today"):
        print(f"Received: {chunk}")
```

## Troubleshooting

### Common Issues

1. **Docker services won't start**
   ```bash
   # Check Docker daemon
   docker ps
   
   # Reset Docker environment
   make clean-all
   make up
   ```

2. **Tests fail with connection errors**
   ```bash
   # Ensure services are healthy
   docker compose ps
   docker compose logs
   
   # Check service endpoints
   curl http://localhost:8080/healthz
   ```

3. **Secret scanning false positives**
   ```bash
   # Add patterns to ignore
   echo "test_file.py" >> .gitleaksignore
   
   # Or use inline comments
   password = "test123"  # gitleaks:allow
   ```

4. **MCP streaming tests timeout**
   ```bash
   # Increase timeout
   pytest tests/integration/test_mcp_streaming.py --timeout=300
   
   # Check proxy configuration
   docker compose exec reverse-proxy cat /etc/nginx/nginx.conf
   ```

### Debug Mode

```bash
# Enable debug logging
export DEBUG_TESTS=true
export PYTEST_OPTS="-vvv --tb=long --log-cli-level=DEBUG"

# Run with debug output
make test

# Or specific test with debugging
pytest tests/unit/test_categorization.py::TestCategorization::test_categorization_accuracy -vvv --pdb
```

## Compliance Verification

### 14-Day Validation

The system requires all gates to pass for 14 consecutive days:

```bash
# Check current streak
cat reports/compliance-matrix.md | grep "Consecutive Pass Days"

# View historical results
make reports
open reports/compliance-matrix.md
```

### Manual Verification

Some checks require manual verification in production:

1. **SSL Labs Test (S2)**
   ```
   Visit: https://www.ssllabs.com/ssltest/
   Enter: your-domain.com
   Target: Grade A or better
   ```

2. **Penetration Testing (S3)**
   ```bash
   # Run OWASP ZAP
   docker run -t owasp/zap2docker-stable zap-baseline.py \
     -t https://your-domain.com
   ```

## Contributing

### Adding New Tests

1. **Create test file** in appropriate directory
2. **Tag with gate ID** in docstring
3. **Update compliance matrix** mapping
4. **Add to CI workflow** if needed

Example:
```python
"""
Test Suite: T6 - New Feature
Gate: T6
"""

import pytest

class TestNewFeature:
    def test_feature_requirement(self):
        """T6 Gate Test: Verify new feature works"""
        assert feature_works() == True
```

### Test Standards

- Use pytest for Python tests
- Follow AAA pattern (Arrange, Act, Assert)
- Mock external dependencies
- Keep tests isolated and idempotent
- Document gate requirements in docstrings
- Aim for <30 second execution per test

## Reports

### Coverage Reports

```bash
# Generate coverage report
make coverage

# View HTML report
open coverage/html/index.html
```

### JUnit XML Results

All test results are exported as JUnit XML for CI integration:
- `reports/unit-results.xml`
- `reports/integration-results.xml`
- `reports/e2e-results.xml`

### Compliance Matrix

The compliance matrix is automatically generated and updated:
```bash
make compliance-check
cat reports/compliance-matrix.md
```

## Support

For issues or questions:
1. Check this README
2. Review test output logs
3. Consult the compliance matrix
4. Create an issue with:
   - Gate ID
   - Test output
   - Environment details
   - Steps to reproduce

---

*Remember: All gates must pass for 14 consecutive days before the system can be trusted and expanded to Iteration 2.*