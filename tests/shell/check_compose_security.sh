#!/bin/bash
# Test Suite: S4 - Container Security & Least Privilege
# Gate: S4 - Non-root, pinned digests, capabilities, resource limits

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EXIT_CODE=0

echo "==========================================="
echo "S4 Gate: Checking Docker Compose Security"
echo "==========================================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Find docker-compose files
COMPOSE_FILES=$(find "${REPO_ROOT}" -name "docker-compose*.yml" -o -name "docker-compose*.yaml" 2>/dev/null | head -5)

if [ -z "$COMPOSE_FILES" ]; then
    echo -e "${RED}✗${NC} No docker-compose files found"
    exit 1
fi

# Function to check if running containers are non-root
check_running_containers_user() {
    echo "Checking running containers for non-root users..."
    
    if ! command -v docker >/dev/null 2>&1; then
        echo -e "${YELLOW}⚠${NC} Docker not available, skipping runtime checks"
        return 0
    fi
    
    local containers
    containers=$(docker ps --format "{{.Names}}" 2>/dev/null || echo "")
    
    if [ -z "$containers" ]; then
        echo -e "${YELLOW}⚠${NC} No running containers to check"
        return 0
    fi
    
    local root_containers=()
    for container in $containers; do
        local user
        user=$(docker inspect "$container" --format '{{.Config.User}}' 2>/dev/null || echo "")
        
        # Skip containers that are not part of our project
        if [[ "$container" != *"adhd-budget"* ]]; then
            continue
        fi
        
        if [ -z "$user" ] || [ "$user" = "0" ] || [ "$user" = "root" ]; then
            # Special cases where root is acceptable
            if [[ "$container" == *"db"* ]] || [[ "$container" == *"postgres"* ]]; then
                echo -e "${YELLOW}⚠${NC} Container running as root (expected for DB): $container"
            elif [[ "$container" == *"test"* ]]; then
                echo -e "${YELLOW}⚠${NC} Container running as root (test container needs Docker access): $container"
            elif [[ "$container" == *"mcp-inspector"* ]]; then
                echo -e "${YELLOW}⚠${NC} Container running as root (MCP Inspector dev tool): $container"
            else
                root_containers+=("$container")
                echo -e "${RED}✗${NC} Container running as root: $container"
            fi
        else
            echo -e "${GREEN}✓${NC} Container running as non-root: $container (user: $user)"
        fi
    done
    
    if [ ${#root_containers[@]} -gt 0 ]; then
        return 1
    fi
    return 0
}

# Check compose files for security settings
check_compose_security() {
    local file=$1
    echo ""
    echo "Analyzing: $(basename "$file")"
    echo "-------------------------------------------"
    
    local has_issues=false
    
    # Check for pinned image digests
    echo "Checking image digests..."
    local images
    images=$(grep -E "^\s*image:" "$file" | sed 's/.*image:\s*//' | tr -d '"' | tr -d "'")
    
    local unpinned=()
    for image in $images; do
        if [[ ! "$image" =~ @sha256:[a-f0-9]{64} ]]; then
            unpinned+=("$image")
            echo -e "${RED}✗${NC} Image not pinned by digest: $image"
            has_issues=true
        else
            echo -e "${GREEN}✓${NC} Image pinned: ${image%%@*}"
        fi
    done
    
    # Check for user specification
    echo ""
    echo "Checking user specifications..."
    if grep -q "^\s*user:" "$file"; then
        local users
        users=$(grep "^\s*user:" "$file" | sed 's/.*user:\s*//' | tr -d '"' | tr -d "'")
        for user in $users; do
            if [ "$user" = "root" ] || [ "$user" = "0" ]; then
                echo -e "${RED}✗${NC} Service explicitly using root user"
                has_issues=true
            else
                echo -e "${GREEN}✓${NC} Service using non-root user: $user"
            fi
        done
    else
        echo -e "${YELLOW}⚠${NC} No explicit user specification (will use image default)"
    fi
    
    # Check for capability drops
    echo ""
    echo "Checking capability management..."
    if grep -q "cap_drop:" "$file"; then
        echo -e "${GREEN}✓${NC} Capability drops configured"
        if grep -q "cap_drop:\s*\n\s*- ALL" "$file"; then
            echo -e "${GREEN}✓${NC} Dropping ALL capabilities (best practice)"
        fi
    else
        echo -e "${YELLOW}⚠${NC} No capability drops configured"
    fi
    
    if grep -q "cap_add:" "$file"; then
        local caps
        caps=$(grep -A10 "cap_add:" "$file" | grep "^\s*-" | sed 's/.*- //')
        echo -e "${YELLOW}⚠${NC} Adding capabilities: $caps"
    fi
    
    # Check for privileged mode
    if grep -q "privileged:\s*true" "$file"; then
        echo -e "${RED}✗${NC} Service running in privileged mode!"
        has_issues=true
    fi
    
    # Check for resource limits
    echo ""
    echo "Checking resource limits..."
    local has_limits=false
    
    if grep -qE "mem_limit:|memory:|cpus:|cpu_count:" "$file"; then
        has_limits=true
        echo -e "${GREEN}✓${NC} Resource limits configured"
        
        # Extract and display limits
        grep -E "mem_limit:|memory:" "$file" | while read -r line; do
            echo "  Memory: $(echo "$line" | sed 's/.*:\s*//')"
        done
        grep -E "cpus:|cpu_count:" "$file" | while read -r line; do
            echo "  CPU: $(echo "$line" | sed 's/.*:\s*//')"
        done
    fi
    
    # Check deploy resources (Compose v3+)
    if grep -q "deploy:" "$file" && grep -q "resources:" "$file"; then
        has_limits=true
        echo -e "${GREEN}✓${NC} Deploy resource limits configured (Compose v3+)"
    fi
    
    if [ "$has_limits" = false ]; then
        echo -e "${RED}✗${NC} No resource limits configured"
        has_issues=true
    fi
    
    # Check for read-only root filesystem
    if grep -q "read_only:\s*true" "$file"; then
        echo -e "${GREEN}✓${NC} Read-only root filesystem enabled"
    fi
    
    # Check for security_opt
    if grep -q "security_opt:" "$file"; then
        echo -e "${GREEN}✓${NC} Security options configured"
        grep -A5 "security_opt:" "$file" | grep "^\s*-" | while read -r line; do
            echo "  $line"
        done
    fi
    
    # Check for tmpfs usage (avoiding disk writes)
    if grep -q "tmpfs:" "$file"; then
        echo -e "${GREEN}✓${NC} Using tmpfs for temporary data"
    fi
    
    if [ "$has_issues" = true ]; then
        return 1
    fi
    return 0
}

# Check Dockerfile security if present
check_dockerfile_security() {
    local dockerfiles
    dockerfiles=$(find "${REPO_ROOT}" -name "Dockerfile*" 2>/dev/null | head -10)
    
    if [ -z "$dockerfiles" ]; then
        echo -e "${YELLOW}⚠${NC} No Dockerfiles found to analyze"
        return 0
    fi
    
    echo ""
    echo "Checking Dockerfile security..."
    echo "-------------------------------------------"
    
    for dockerfile in $dockerfiles; do
        echo "Analyzing: $(basename "$dockerfile")"
        
        # Check for USER instruction
        if grep -q "^USER " "$dockerfile"; then
            local user
            user=$(grep "^USER " "$dockerfile" | tail -1 | awk '{print $2}')
            if [ "$user" != "root" ] && [ "$user" != "0" ]; then
                echo -e "${GREEN}✓${NC} Dockerfile sets non-root USER: $user"
            else
                # Special cases where root is acceptable
                if [[ "$dockerfile" == *"test"* ]]; then
                    echo -e "${YELLOW}⚠${NC} Dockerfile sets root USER (test container needs Docker access)"
                elif [[ "$dockerfile" == *"postgres"* ]]; then
                    echo -e "${YELLOW}⚠${NC} Dockerfile sets root USER (postgres needs root for initialization)"
                else
                    echo -e "${RED}✗${NC} Dockerfile sets root USER"
                    EXIT_CODE=1
                fi
            fi
        else
            # Special cases where no USER is acceptable
            if [[ "$dockerfile" == *"postgres"* ]]; then
                echo -e "${YELLOW}⚠${NC} No USER instruction in Dockerfile (using base postgres image defaults)"
            else
                echo -e "${RED}✗${NC} No USER instruction in Dockerfile"
                EXIT_CODE=1
            fi
        fi
        
        # Check for sudo usage
        if grep -q "sudo\|apt-get install.*sudo" "$dockerfile"; then
            echo -e "${YELLOW}⚠${NC} Dockerfile installs or uses sudo"
        fi
        
        # Check base image
        if grep -q "^FROM.*:latest" "$dockerfile"; then
            echo -e "${YELLOW}⚠${NC} Using :latest tag for base image (not pinned)"
        fi
        
        # Check for HEALTHCHECK
        if grep -q "^HEALTHCHECK" "$dockerfile"; then
            echo -e "${GREEN}✓${NC} HEALTHCHECK defined"
        fi
        
        echo ""
    done
}

# Generate security recommendations
generate_recommendations() {
    echo ""
    echo "Security Recommendations:"
    echo "-------------------------------------------"
    cat << EOF
1. Pin all images by digest:
   image: nginx@sha256:abc123...

2. Run containers as non-root:
   user: "1000:1000"
   
3. Drop unnecessary capabilities:
   cap_drop:
     - ALL
   cap_add:
     - NET_BIND_SERVICE  # Only if needed

4. Set resource limits:
   mem_limit: 512m
   cpus: '0.5'
   
5. Use read-only filesystem where possible:
   read_only: true
   tmpfs:
     - /tmp
     - /var/run

6. Add security options:
   security_opt:
     - no-new-privileges
     - seccomp:unconfined  # Or custom profile

7. For Dockerfiles:
   - Create non-root user
   - Use COPY --chown=user:group
   - Set USER before ENTRYPOINT
EOF
}

# Main execution
main() {
    local all_passed=true
    
    # Check compose files
    for file in $COMPOSE_FILES; do
        if ! check_compose_security "$file"; then
            all_passed=false
            EXIT_CODE=1
        fi
    done
    
    echo ""
    # Check running containers
    if ! check_running_containers_user; then
        all_passed=false
        EXIT_CODE=1
    fi
    
    # Check Dockerfiles
    check_dockerfile_security
    
    # Show recommendations if issues found
    if [ "$all_passed" = false ]; then
        generate_recommendations
    fi
    
    echo ""
    echo "==========================================="
    if [ $EXIT_CODE -eq 0 ]; then
        echo -e "${GREEN}✓ S4 PASSED:${NC} Container security checks passed"
    else
        echo -e "${RED}✗ S4 FAILED:${NC} Container security issues found"
        echo "Please address the security concerns above"
    fi
    echo "==========================================="
    
    exit $EXIT_CODE
}

main "$@"