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
    
    # Common secret patterns
    local patterns=(
        # AWS Keys
        "AKIA[0-9A-Z]{16}"
        "aws[_\s]*access[_\s]*key[_\s]*id.*=.*['\"]?[A-Z0-9]{20}['\"]?"
        "aws[_\s]*secret[_\s]*access[_\s]*key.*=.*['\"]?[A-Za-z0-9/+=]{40}['\"]?"
        
        # API Keys
        "api[_\-\s]*key.*=.*['\"]?[A-Za-z0-9\-_]{20,}['\"]?"
        "apikey.*[:=].*[A-Za-z0-9\-_]{20,}"
        
        # Private Keys
        "-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY"
        "-----BEGIN PGP PRIVATE KEY"
        
        # OAuth/Tokens
        "oauth.*=.*['\"]?[A-Za-z0-9\-._~+/]{20,}['\"]?"
        "token.*[:=].*['\"]?[A-Za-z0-9\-._~+/]{20,}['\"]?"
        "bearer.*[:=].*['\"]?[A-Za-z0-9\-._~+/]{20,}['\"]?"
        
        # Database URLs
        "postgres://.*:.*@"
        "mysql://.*:.*@"
        "mongodb://.*:.*@"
        "redis://.*:.*@"
        
        # Generic Secrets
        "password.*[:=].*['\"]?[^\s]{8,}['\"]?"
        "passwd.*[:=].*['\"]?[^\s]{8,}['\"]?"
        "pwd.*[:=].*['\"]?[^\s]{8,}['\"]?"
        "secret.*[:=].*['\"]?[A-Za-z0-9\-._~+/]{10,}['\"]?"
        "client[_\s]*secret.*[:=].*['\"]?[A-Za-z0-9\-._~+/]{20,}['\"]?"
        
        # Bank/Financial
        "enable[_\s]*banking.*key"
        "bank[_\s]*api[_\s]*key"
        "payment[_\s]*secret"
    )
    
    echo "Checking git history for secret patterns..."
    for pattern in "${patterns[@]}"; do
        # Search in git history (excluding .gitignore and this script)
        if git log -p -i -E --all --grep="${pattern}" 2>/dev/null | grep -qiE "${pattern}"; then
            echo -e "${RED}✗${NC} Found potential secret matching pattern: ${pattern}"
            found_secrets=$((found_secrets + 1))
        fi
    done
    
    # Check current working directory
    echo "Checking working directory..."
    for pattern in "${patterns[@]}"; do
        if find "${REPO_ROOT}" -type f \
            -not -path "*/\.git/*" \
            -not -path "*/node_modules/*" \
            -not -path "*/venv/*" \
            -not -path "*/__pycache__/*" \
            -not -name "*.pyc" \
            -not -name "scan_git_secrets.sh" \
            -exec grep -l -i -E "${pattern}" {} \; 2>/dev/null | head -n 1 | grep -q .; then
            echo -e "${RED}✗${NC} Found potential secret in working directory matching: ${pattern}"
            found_secrets=$((found_secrets + 1))
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
        
        # Check for hardcoded secrets
        if grep -qE "password:|PASSWORD=|secret:|SECRET=|api_key:|API_KEY=" "$file" | grep -v "^\s*#"; then
            if ! grep -qE "\${.*}|secrets:" "$file"; then
                echo -e "${RED}✗${NC} S1 WARNING: Possible hardcoded secrets in $file"
                EXIT_CODE=1
            fi
        fi
        
        # Check for env_file or secrets usage
        if grep -qE "env_file:|secrets:" "$file"; then
            echo -e "${GREEN}✓${NC} Using env_file or Docker secrets in $file"
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
        echo -e "${YELLOW}⚠${NC} No specialized secret scanners found, using grep patterns"
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