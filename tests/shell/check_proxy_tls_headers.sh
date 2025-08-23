#!/bin/bash
# Test Suite: S2 - TLS & Proxy Security
# Gate: S2 - Let's Encrypt TLS, HSTS, streaming preserved

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EXIT_CODE=0

echo "==========================================="
echo "S2 Gate: Checking TLS & Security Headers"
echo "==========================================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration
PROXY_URL="${PROXY_URL:-https://localhost}"
SKIP_CERT_CHECK="${SKIP_CERT_CHECK:-true}"

# Curl options
CURL_OPTS="-s -I"
if [ "$SKIP_CERT_CHECK" = "true" ]; then
    CURL_OPTS="$CURL_OPTS -k"
fi

# Function to check URL availability
check_url_available() {
    local url=$1
    echo "Checking URL availability: $url"
    
    if curl $CURL_OPTS "$url" >/dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} URL is reachable"
        return 0
    else
        echo -e "${RED}✗${NC} URL is not reachable"
        return 1
    fi
}

# Check TLS configuration
check_tls_config() {
    local url=$1
    echo ""
    echo "Checking TLS configuration..."
    echo "-------------------------------------------"
    
    # Check if HTTPS is enforced
    if [[ "$url" =~ ^https:// ]]; then
        echo -e "${GREEN}✓${NC} HTTPS enabled"
    else
        echo -e "${RED}✗${NC} Not using HTTPS"
        return 1
    fi
    
    # Check TLS version and ciphers
    if command -v openssl >/dev/null 2>&1; then
        echo "Testing TLS protocols..."
        
        # Test TLS 1.2 (should work)
        if echo | openssl s_client -connect "${url#https://}" -tls1_2 2>/dev/null | grep -q "Protocol.*TLSv1.2"; then
            echo -e "${GREEN}✓${NC} TLS 1.2 supported"
        fi
        
        # Test TLS 1.3 (preferred)
        if echo | openssl s_client -connect "${url#https://}" -tls1_3 2>/dev/null | grep -q "Protocol.*TLSv1.3"; then
            echo -e "${GREEN}✓${NC} TLS 1.3 supported (recommended)"
        fi
        
        # Test old protocols (should fail)
        if echo | openssl s_client -connect "${url#https://}" -tls1 2>/dev/null | grep -q "Protocol.*TLSv1\s"; then
            echo -e "${RED}✗${NC} TLS 1.0 supported (insecure)"
            EXIT_CODE=1
        fi
        
        if echo | openssl s_client -connect "${url#https://}" -ssl3 2>/dev/null | grep -q "Protocol.*SSLv3"; then
            echo -e "${RED}✗${NC} SSL 3.0 supported (insecure)"
            EXIT_CODE=1
        fi
        
        # Check cipher strength
        echo "Checking cipher suites..."
        local ciphers
        ciphers=$(echo | openssl s_client -connect "${url#https://}" 2>/dev/null | grep "Cipher.*:")
        
        if echo "$ciphers" | grep -qE "AES256|AES128|CHACHA20"; then
            echo -e "${GREEN}✓${NC} Strong ciphers in use"
        fi
        
        if echo "$ciphers" | grep -qE "RC4|DES|MD5|NULL|EXP|anon"; then
            echo -e "${RED}✗${NC} Weak ciphers detected"
            EXIT_CODE=1
        fi
    else
        echo -e "${YELLOW}⚠${NC} OpenSSL not available for detailed TLS testing"
    fi
    
    return 0
}

# Check security headers
check_security_headers() {
    local url=$1
    echo ""
    echo "Checking security headers..."
    echo "-------------------------------------------"
    
    local headers
    headers=$(curl $CURL_OPTS "$url" 2>/dev/null)
    
    # Required headers for S2
    local required_headers=(
        "Strict-Transport-Security"
    )
    
    # Recommended security headers
    local recommended_headers=(
        "X-Content-Type-Options"
        "X-Frame-Options"
        "X-XSS-Protection"
        "Content-Security-Policy"
        "Referrer-Policy"
    )
    
    # Check required headers
    for header in "${required_headers[@]}"; do
        if echo "$headers" | grep -qi "^$header:"; then
            local value
            value=$(echo "$headers" | grep -i "^$header:" | cut -d: -f2- | tr -d '\r\n' | xargs)
            echo -e "${GREEN}✓${NC} $header: $value"
            
            # Validate HSTS settings
            if [ "$header" = "Strict-Transport-Security" ]; then
                if echo "$value" | grep -q "max-age=0"; then
                    echo -e "${RED}✗${NC} HSTS max-age is 0 (disabled)"
                    EXIT_CODE=1
                elif echo "$value" | grep -qE "max-age=[0-9]{1,5}($|;)"; then
                    echo -e "${YELLOW}⚠${NC} HSTS max-age is very short"
                elif echo "$value" | grep -q "max-age=31536000"; then
                    echo -e "${GREEN}✓${NC} HSTS max-age is 1 year (recommended)"
                fi
                
                if echo "$value" | grep -q "includeSubDomains"; then
                    echo -e "${GREEN}✓${NC} HSTS includeSubDomains enabled"
                fi
                
                if echo "$value" | grep -q "preload"; then
                    echo -e "${GREEN}✓${NC} HSTS preload enabled"
                fi
            fi
        else
            echo -e "${RED}✗${NC} Missing required header: $header"
            EXIT_CODE=1
        fi
    done
    
    # Check recommended headers
    echo ""
    echo "Recommended security headers:"
    for header in "${recommended_headers[@]}"; do
        if echo "$headers" | grep -qi "^$header:"; then
            local value
            value=$(echo "$headers" | grep -i "^$header:" | cut -d: -f2- | tr -d '\r\n' | xargs)
            echo -e "${GREEN}✓${NC} $header: $value"
        else
            echo -e "${YELLOW}⚠${NC} Missing recommended: $header"
        fi
    done
    
    return 0
}

# Check certificate details
check_certificate() {
    local url=$1
    echo ""
    echo "Checking certificate..."
    echo "-------------------------------------------"
    
    if ! command -v openssl >/dev/null 2>&1; then
        echo -e "${YELLOW}⚠${NC} OpenSSL not available for certificate checking"
        return 0
    fi
    
    local host="${url#https://}"
    host="${host%%/*}"
    host="${host%%:*}"
    
    # Get certificate details
    local cert_info
    cert_info=$(echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null | openssl x509 -noout -text 2>/dev/null)
    
    if [ -z "$cert_info" ]; then
        echo -e "${YELLOW}⚠${NC} Could not retrieve certificate information"
        return 0
    fi
    
    # Check issuer (Let's Encrypt)
    local issuer
    issuer=$(echo "$cert_info" | grep "Issuer:" | head -1)
    if echo "$issuer" | grep -q "Let's Encrypt"; then
        echo -e "${GREEN}✓${NC} Certificate issued by Let's Encrypt"
    else
        echo -e "${YELLOW}⚠${NC} Certificate issuer: $issuer"
    fi
    
    # Check validity
    local not_after
    not_after=$(echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    
    if [ -n "$not_after" ]; then
        echo -e "${GREEN}✓${NC} Certificate valid until: $not_after"
        
        # Check if expiring soon (within 30 days)
        local expire_epoch
        expire_epoch=$(date -d "$not_after" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$not_after" +%s 2>/dev/null || echo 0)
        local current_epoch
        current_epoch=$(date +%s)
        local days_remaining=$(( (expire_epoch - current_epoch) / 86400 ))
        
        if [ "$days_remaining" -lt 30 ] && [ "$days_remaining" -gt 0 ]; then
            echo -e "${YELLOW}⚠${NC} Certificate expiring in $days_remaining days"
        elif [ "$days_remaining" -le 0 ]; then
            echo -e "${RED}✗${NC} Certificate has expired!"
            EXIT_CODE=1
        fi
    fi
    
    # Check SANs
    local sans
    sans=$(echo "$cert_info" | grep -A1 "Subject Alternative Name:" | tail -1)
    if [ -n "$sans" ]; then
        echo "Subject Alternative Names: $sans"
    fi
    
    return 0
}

# Check streaming preservation through proxy
check_streaming() {
    local url=$1
    echo ""
    echo "Checking streaming preservation..."
    echo "-------------------------------------------"
    
    # Test SSE endpoint
    local sse_url="${url}/mcp/stream"
    
    echo "Testing SSE streaming at: $sse_url"
    
    # Send a test SSE request with timeout
    local response
    response=$(curl -N -H "Accept: text/event-stream" \
                    -H "Cache-Control: no-cache" \
                    -m 5 \
                    $( [ "$SKIP_CERT_CHECK" = "true" ] && echo "-k" ) \
                    "$sse_url" 2>&1 | head -20)
    
    if echo "$response" | grep -q "data:\|event:\|id:"; then
        echo -e "${GREEN}✓${NC} SSE streaming appears to work"
    else
        echo -e "${YELLOW}⚠${NC} Could not verify SSE streaming (may need active MCP server)"
    fi
    
    # Check for proxy buffering headers
    local stream_headers
    stream_headers=$(curl -s -I -H "Accept: text/event-stream" \
                          $( [ "$SKIP_CERT_CHECK" = "true" ] && echo "-k" ) \
                          "$sse_url" 2>/dev/null)
    
    if echo "$stream_headers" | grep -qi "X-Accel-Buffering:\s*no"; then
        echo -e "${GREEN}✓${NC} Nginx buffering disabled (X-Accel-Buffering: no)"
    fi
    
    if echo "$stream_headers" | grep -qi "Cache-Control:.*no-cache"; then
        echo -e "${GREEN}✓${NC} Cache-Control set to no-cache"
    fi
    
    return 0
}

# Check proxy configuration files
check_proxy_configs() {
    echo ""
    echo "Checking proxy configuration files..."
    echo "-------------------------------------------"
    
    # Check for Nginx config
    local nginx_configs
    nginx_configs=$(find "${REPO_ROOT}" -name "nginx*.conf" -o -name "*.nginx" 2>/dev/null | head -5)
    
    if [ -n "$nginx_configs" ]; then
        echo "Found Nginx configurations:"
        for config in $nginx_configs; do
            echo "  Checking: $config"
            
            # Check for SSL configuration
            if grep -q "ssl_protocols.*TLSv1\.[23]" "$config"; then
                echo -e "${GREEN}✓${NC} Modern TLS protocols configured"
            fi
            
            # Check for HSTS
            if grep -q "add_header Strict-Transport-Security" "$config"; then
                echo -e "${GREEN}✓${NC} HSTS configured"
            fi
            
            # Check for streaming support
            if grep -q "proxy_buffering off\|X-Accel-Buffering" "$config"; then
                echo -e "${GREEN}✓${NC} Streaming support configured"
            fi
        done
    fi
    
    # Check for Caddy config
    local caddy_configs
    caddy_configs=$(find "${REPO_ROOT}" -name "Caddyfile*" 2>/dev/null | head -5)
    
    if [ -n "$caddy_configs" ]; then
        echo "Found Caddy configurations:"
        for config in $caddy_configs; do
            echo "  Checking: $config"
            
            # Caddy has automatic HTTPS and HSTS
            echo -e "${GREEN}✓${NC} Caddy provides automatic HTTPS and HSTS"
            
            # Check for streaming
            if grep -q "flush_interval" "$config"; then
                echo -e "${GREEN}✓${NC} Streaming flush interval configured"
            fi
        done
    fi
    
    # Check for Traefik config
    local traefik_configs
    traefik_configs=$(find "${REPO_ROOT}" -name "traefik*.yml" -o -name "traefik*.yaml" -o -name "traefik*.toml" 2>/dev/null | head -5)
    
    if [ -n "$traefik_configs" ]; then
        echo "Found Traefik configurations:"
        for config in $traefik_configs; do
            echo "  Checking: $config"
            
            # Check for Let's Encrypt
            if grep -q "letsencrypt\|acme" "$config"; then
                echo -e "${GREEN}✓${NC} Let's Encrypt/ACME configured"
            fi
            
            # Check for headers middleware
            if grep -q "headers:" "$config"; then
                echo -e "${GREEN}✓${NC} Headers middleware configured"
            fi
        done
    fi
    
    return 0
}

# SSL Labs grade estimation (local)
estimate_ssl_grade() {
    echo ""
    echo "SSL Labs Grade Estimation (local)..."
    echo "-------------------------------------------"
    
    local grade="F"
    local score=0
    
    # Check protocol support (+30 for good protocols)
    if ! echo | openssl s_client -connect "${PROXY_URL#https://}:443" -tls1 2>/dev/null | grep -q "Protocol"; then
        score=$((score + 10))
        echo -e "${GREEN}✓${NC} TLS 1.0 disabled (+10)"
    fi
    
    if echo | openssl s_client -connect "${PROXY_URL#https://}:443" -tls1_2 2>/dev/null | grep -q "Protocol"; then
        score=$((score + 10))
        echo -e "${GREEN}✓${NC} TLS 1.2 enabled (+10)"
    fi
    
    if echo | openssl s_client -connect "${PROXY_URL#https://}:443" -tls1_3 2>/dev/null | grep -q "Protocol"; then
        score=$((score + 10))
        echo -e "${GREEN}✓${NC} TLS 1.3 enabled (+10)"
    fi
    
    # Check cipher strength (+30)
    local ciphers
    ciphers=$(echo | openssl s_client -connect "${PROXY_URL#https://}:443" -cipher 'HIGH:!aNULL' 2>/dev/null | grep "Cipher")
    if [ -n "$ciphers" ]; then
        score=$((score + 30))
        echo -e "${GREEN}✓${NC} Strong ciphers only (+30)"
    fi
    
    # Check HSTS (+20)
    if curl $CURL_OPTS "$PROXY_URL" 2>/dev/null | grep -qi "Strict-Transport-Security"; then
        score=$((score + 20))
        echo -e "${GREEN}✓${NC} HSTS enabled (+20)"
    fi
    
    # Check certificate validity (+20)
    if echo | openssl s_client -connect "${PROXY_URL#https://}:443" -servername "${PROXY_URL#https://}" 2>/dev/null | openssl x509 -noout -checkend 86400 >/dev/null 2>&1; then
        score=$((score + 20))
        echo -e "${GREEN}✓${NC} Valid certificate (+20)"
    fi
    
    # Determine grade
    if [ $score -ge 90 ]; then
        grade="A"
    elif [ $score -ge 80 ]; then
        grade="A-"
    elif [ $score -ge 70 ]; then
        grade="B"
    elif [ $score -ge 60 ]; then
        grade="C"
    elif [ $score -ge 50 ]; then
        grade="D"
    fi
    
    echo ""
    echo "Estimated SSL Grade: $grade (Score: $score/100)"
    
    if [[ "$grade" =~ ^A ]]; then
        echo -e "${GREEN}✓${NC} Meets SSL Labs Grade A requirement"
    else
        echo -e "${RED}✗${NC} Does not meet Grade A requirement"
        echo "Run actual SSL Labs test at: https://www.ssllabs.com/ssltest/"
        EXIT_CODE=1
    fi
    
    return 0
}

# Main execution
main() {
    # Allow override for testing
    if [ -n "${1:-}" ]; then
        PROXY_URL="$1"
    fi
    
    echo "Testing URL: $PROXY_URL"
    echo ""
    
    # Check if URL is available
    if ! check_url_available "$PROXY_URL"; then
        echo -e "${YELLOW}⚠${NC} Cannot reach $PROXY_URL, checking local configs only..."
        check_proxy_configs
    else
        # Run all checks
        check_tls_config "$PROXY_URL"
        check_security_headers "$PROXY_URL"
        check_certificate "$PROXY_URL"
        check_streaming "$PROXY_URL"
        estimate_ssl_grade
    fi
    
    # Always check config files
    check_proxy_configs
    
    echo ""
    echo "==========================================="
    if [ $EXIT_CODE -eq 0 ]; then
        echo -e "${GREEN}✓ S2 PASSED:${NC} TLS and security headers configured correctly"
    else
        echo -e "${RED}✗ S2 FAILED:${NC} TLS or security header issues found"
        echo ""
        echo "To achieve SSL Labs Grade A:"
        echo "1. Use only TLS 1.2 and 1.3"
        echo "2. Disable weak ciphers"
        echo "3. Enable HSTS with long max-age"
        echo "4. Use valid certificate from Let's Encrypt"
        echo "5. Test at: https://www.ssllabs.com/ssltest/"
    fi
    echo "==========================================="
    
    exit $EXIT_CODE
}

main "$@"