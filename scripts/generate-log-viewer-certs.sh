#!/bin/bash
set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CERTS_DIR="$PROJECT_ROOT/certs"

echo "=========================================="
echo "Generating mTLS Certificates"
echo "=========================================="
echo ""
echo "Project Root: $PROJECT_ROOT"
echo "Certs Directory: $CERTS_DIR"
echo ""

# Create certs directory if it doesn't exist
mkdir -p "$CERTS_DIR"
cd "$CERTS_DIR"

# 1. Generate CA private key
echo "[1/8] Generating CA private key..."
openssl genrsa -out ca.key 2048 2>/dev/null

# 2. Generate CA certificate
echo "[2/8] Generating CA certificate..."
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
    -out ca.crt -config openssl-ca.cnf 2>/dev/null

# 3. Generate server private key
echo "[3/8] Generating server private key..."
openssl genrsa -out server.key 2048 2>/dev/null

# 4. Generate server CSR
echo "[4/8] Generating server CSR..."
openssl req -new -key server.key -out server.csr -config openssl-server.cnf 2>/dev/null

# 5. Sign server certificate with CA
echo "[5/8] Signing server certificate..."
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out server.crt -days 365 -sha256 -extensions v3_req -extfile openssl-server.cnf 2>/dev/null

# 6. Generate client private key
echo "[6/8] Generating client private key..."
openssl genrsa -out client.key 2048 2>/dev/null

# 7. Generate client CSR
echo "[7/8] Generating client CSR..."
openssl req -new -key client.key -out client.csr -config openssl-client.cnf 2>/dev/null

# 8. Sign client certificate with CA
echo "[8/8] Signing client certificate..."
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out client.crt -days 365 -sha256 -extensions v3_req -extfile openssl-client.cnf 2>/dev/null

# Clean up CSR files
rm -f server.csr client.csr

# Set appropriate permissions
chmod 600 *.key
chmod 644 *.crt

echo ""
echo "=========================================="
echo "✓ mTLS Certificates Generated Successfully!"
echo "=========================================="
echo ""
echo "Files created in $CERTS_DIR:"
echo "  ✓ ca.crt (CA certificate)"
echo "  ✓ ca.key (CA private key)"
echo "  ✓ server.crt (Server certificate)"
echo "  ✓ server.key (Server private key)"
echo "  ✓ client.crt (Client certificate)"
echo "  ✓ client.key (Client private key)"
echo ""
echo "Verifying certificates..."
if openssl verify -CAfile ca.crt server.crt >/dev/null 2>&1; then
    echo "  ✓ Server certificate valid"
else
    echo "  ✗ Server certificate verification failed"
fi
if openssl verify -CAfile ca.crt client.crt >/dev/null 2>&1; then
    echo "  ✓ Client certificate valid"
else
    echo "  ✗ Client certificate verification failed"
fi
echo ""
echo "Certificate expiration dates:"
echo "  CA: $(openssl x509 -in ca.crt -noout -enddate | cut -d= -f2)"
echo "  Server: $(openssl x509 -in server.crt -noout -enddate | cut -d= -f2)"
echo "  Client: $(openssl x509 -in client.crt -noout -enddate | cut -d= -f2)"
echo ""
echo "Next steps:"
echo "  1. Start the log-viewer service: docker compose up -d log-viewer"
echo "  2. Test the service:"
echo "     curl https://localhost:8888/health \\"
echo "       --cacert $CERTS_DIR/ca.crt \\"
echo "       --cert $CERTS_DIR/client.crt \\"
echo "       --key $CERTS_DIR/client.key"
echo ""
