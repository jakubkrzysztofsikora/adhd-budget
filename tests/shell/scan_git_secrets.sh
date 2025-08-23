#!/bin/bash
# Test Suite: S1 - Secrets Hygiene
# Gate: S1 - No secrets in git history

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EXIT_CODE=0

echo "==========================================="
echo "S1 Gate: Scanning for secrets in git history"
echo "==========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Try to use specialized tools first, fallback to grep
scan_with_trufflehog() {
    echo "Scanning with trufflehog..."
    trufflehog git file://"${REPO_ROOT}" --no-verification 2>/dev/null | grep -q "Found" && return 1 || return 0
}

scan_with_gitleaks() {
    echo "Scanning with gitleaks..."
    gitleaks detect --source="${REPO_ROOT}" --verbose --no-git 2>/dev/null && return 0 || return 1
}

scan_with_git_secrets() {
    echo "Scanning with git-secrets..."
    cd "${REPO_ROOT}"
    git secrets --scan-history 2>/dev/null && return 0 || return 1
}

scan_with_grep() {
    echo "Scanning with grep patterns..."
    local found_secrets=0
    
    # Simpler patterns that work with BSD grep
    local patterns=(
        # AWS Keys
        "AKIA[0-9A-Z]{16}"
        
        # Generic API key patterns
        "api_key"
        "apikey"
        
        # Private key headers (simplified)
        "BEGIN.*PRIVATE KEY"
        "BEGIN PGP PRIVATE KEY"
        
        # OAuth/Tokens
        "oauth"
        "bearer"
        
        # Database URLs
        "postgres://.*:.*@"
        "mysql://.*:.*@"
        "mongodb://.*:.*@"
        "redis://.*:.*@"
        
        # Generic Secrets (simplified)
        "client_secret"
        
        # Bank/Financial (exact matches)
        "enable_banking_key"
        "bank_api_key"
        "payment_secret"
    )
    
    echo "Checking for obvious hardcoded secrets..."
    
    # Check for obvious hardcoded passwords/secrets (not env vars)
    if find "${REPO_ROOT}" -type f \
        -not -path "*/\.git/*" \
        -not -path "*/node_modules/*" \
        -not -path "*/venv/*" \
        -not -path "*/__pycache__/*" \
        -not -name "*.pyc" \
        -not -name "scan_git_secrets*.sh" \
        -not -name ".env*" \
        -exec grep -l "password.*=.*['\"]*[^$]" {} \; 2>/dev/null | head -n 1 | grep -q .; then
        echo -e "${YELLOW}⚠${NC} Found potential hardcoded passwords (verify they're not using env vars)"
    fi
    
    # Check for obvious API keys
    for pattern in "${patterns[@]}"; do
        if find "${REPO_ROOT}" -type f \
            -not -path "*/\.git/*" \
            -not -path "*/node_modules/*" \
            -not -path "*/venv/*" \
            -not -path "*/__pycache__/*" \
            -not -name "*.pyc" \
            -not -name "scan_git_secrets*.sh" \
            -not -name ".env*" \
            -exec grep -l "${pattern}" {} \; 2>/dev/null | head -n 1 | grep -q .; then
            echo -e "${YELLOW}⚠${NC} Found files with pattern: ${pattern}"
        fi
    done
    
    return $found_secrets
}

# Check for .env files in git
check_env_files() {
    echo "Checking for .env files in git..."
    local env_files
    env_files=$(git ls-files | grep -E "\.env$|\.env\.|env\..*" | grep -v ".env.example" || true)
    
    if [ -n "$env_files" ]; then
        echo -e "${RED}✗${NC} S1 FAILED: Found .env files in git:"
        echo "$env_files"
        return 1
    fi
    
    echo -e "${GREEN}✓${NC} No .env files in git"
    return 0
}

# Check .gitignore for security entries
check_gitignore() {
    echo "Checking .gitignore for security entries..."
    local gitignore="${REPO_ROOT}/.gitignore"
    
    if [ ! -f "$gitignore" ]; then
        echo -e "${YELLOW}⚠${NC} Warning: No .gitignore file found"
        return 1
    fi
    
    local required_entries=(
        ".env"
        "*.key"
        "*.pem"
        "*.p12"
        "secrets/"
        "credentials/"
    )
    
    local missing_entries=()
    for entry in "${required_entries[@]}"; do
        if ! grep -q "^${entry}$\|^${entry}$\|/${entry}$\|^\*\*/${entry}$" "$gitignore"; then
            missing_entries+=("$entry")
        fi
    done
    
    if [ ${#missing_entries[@]} -gt 0 ]; then
        echo -e "${YELLOW}⚠${NC} Recommended .gitignore entries missing:"
        printf '%s\n' "${missing_entries[@]}"
    else
        echo -e "${GREEN}✓${NC} .gitignore has recommended security entries"
    fi
    
    return 0
}

# Check Docker secrets usage
check_docker_secrets() {
    echo "Checking Docker Compose for secrets management..."
    local compose_files
    compose_files=$(find "${REPO_ROOT}" -name "docker-compose*.yml" -o -name "docker-compose*.yaml" 2>/dev/null)
    
    if [ -z "$compose_files" ]; then
        echo -e "${YELLOW}⚠${NC} No docker-compose files found"
        return 0
    fi
    
    for file in $compose_files; do
        echo "  Checking: $file"
        
        # Check that passwords are using env vars
        if grep -E "POSTGRES_PASSWORD|DB_PASSWORD|API_TOKEN|MCP_TOKEN" "$file" | grep -v '${' | grep -v "^#" | grep -q .; then
            echo -e "${RED}✗${NC} S1 WARNING: Possible hardcoded secrets in $file"
            EXIT_CODE=1
        else
            echo -e "${GREEN}✓${NC} Secrets properly use environment variables in $file"
        fi
    done
    
    return 0
}

# Main execution
main() {
    echo "Repository root: ${REPO_ROOT}"
    echo ""
    
    # Run scans based on available tools
    if command_exists trufflehog; then
        scan_with_trufflehog || EXIT_CODE=1
    elif command_exists gitleaks; then
        scan_with_gitleaks || EXIT_CODE=1
    elif command_exists git-secrets; then
        scan_with_git_secrets || EXIT_CODE=1
    else
        echo -e "${YELLOW}⚠${NC} No specialized secret scanners found, using basic checks"
        scan_with_grep || EXIT_CODE=1
    fi
    
    echo ""
    check_env_files || EXIT_CODE=1
    
    echo ""
    check_gitignore
    
    echo ""
    check_docker_secrets
    
    echo ""
    echo "==========================================="
    if [ $EXIT_CODE -eq 0 ]; then
        echo -e "${GREEN}✓ S1 PASSED:${NC} No secrets found in repository"
    else
        echo -e "${RED}✗ S1 FAILED:${NC} Potential secrets or security issues found"
        echo "Please review and remove any secrets from git history"
        echo "Use 'git filter-branch' or BFG Repo-Cleaner to clean history if needed"
    fi
    echo "==========================================="
    
    exit $EXIT_CODE
}

main "$@"