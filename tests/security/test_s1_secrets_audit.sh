#!/bin/bash
# S1 Gate: Secrets Hygiene Audit
# Fixed grep patterns and proper validation

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXIT_CODE=0

echo "=========================================="
echo "S1 Gate: Secrets Hygiene Audit"
echo "=========================================="

# Check for secrets in git history
echo "Checking git history for secrets..."

# Use git log with proper patterns
PATTERNS=(
    'password[:=]'
    'secret[:=]'
    'api[_-]key[:=]'
    'token[:=]'
    'AKIA[0-9A-Z]{16}'  # AWS keys
    'client_secret'
)

for pattern in "${PATTERNS[@]}"; do
    if git log --all --grep="$pattern" -i --oneline 2>/dev/null | grep -q .; then
        echo "❌ Found potential secret pattern: $pattern"
        EXIT_CODE=1
    fi
done

# Check current files
echo "Checking current files..."

# Exclude test files and this script
find "$REPO_ROOT" -type f \
    -not -path "*/\.git/*" \
    -not -path "*/node_modules/*" \
    -not -path "*/venv/*" \
    -not -name "*.pyc" \
    -not -name "$(basename "$0")" \
    -exec grep -l -E "(password|secret|api_key|token)[:=]['\"]?[A-Za-z0-9]+" {} \; 2>/dev/null | while read -r file; do
    
    # Skip if it's a test file or example
    if [[ "$file" == *"test"* ]] || [[ "$file" == *".example"* ]]; then
        continue
    fi
    
    echo "⚠️  Potential secret in: $file"
    EXIT_CODE=1
done

# Check for .env files in git
echo "Checking for .env files in git..."
if git ls-files | grep -E "^\.env$|\.env\." | grep -v ".env.example"; then
    echo "❌ Found .env file in git"
    EXIT_CODE=1
fi

# Verify .gitignore has security entries
echo "Checking .gitignore..."
if [ -f "$REPO_ROOT/.gitignore" ]; then
    REQUIRED=(
        ".env"
        "*.key"
        "*.pem"
    )
    
    for entry in "${REQUIRED[@]}"; do
        if ! grep -q "^$entry$" "$REPO_ROOT/.gitignore"; then
            echo "⚠️  Missing .gitignore entry: $entry"
        fi
    done
else
    echo "❌ No .gitignore file"
    EXIT_CODE=1
fi

# Check docker-compose for hardcoded secrets
echo "Checking docker-compose.yml..."
if [ -f "$REPO_ROOT/docker-compose.yml" ]; then
    if grep -E "password:|PASSWORD=|secret:|SECRET=" "$REPO_ROOT/docker-compose.yml" | grep -v '${' | grep -v "^#"; then
        echo "⚠️  Possible hardcoded secret in docker-compose.yml"
    fi
fi

echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ S1 PASSED: No secrets found"
else
    echo "❌ S1 FAILED: Security issues found"
fi

exit $EXIT_CODE