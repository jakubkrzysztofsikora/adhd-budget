#!/bin/bash
set -e

CERTS_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$CERTS_DIR"

echo "Generating mTLS certificates for log-viewer service..."

# 1. Generate CA private key
echo "1. Generating CA private key..."
openssl genrsa -out ca.key 2048

# 2. Generate CA certificate
echo "2. Generating CA certificate..."
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
    -out ca.crt -config openssl-ca.cnf

# 3. Generate server private key
echo "3. Generating server private key..."
openssl genrsa -out server.key 2048

# 4. Generate server CSR
echo "4. Generating server CSR..."
openssl req -new -key server.key -out server.csr -config openssl-server.cnf

# 5. Sign server certificate with CA
echo "5. Signing server certificate..."
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out server.crt -days 365 -sha256 -extensions v3_req -extfile openssl-server.cnf

# 6. Generate client private key
echo "6. Generating client private key..."
openssl genrsa -out client.key 2048

# 7. Generate client CSR
echo "7. Generating client CSR..."
openssl req -new -key client.key -out client.csr -config openssl-client.cnf

# 8. Sign client certificate with CA
echo "8. Signing client certificate..."
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out client.crt -days 365 -sha256 -extensions v3_req -extfile openssl-client.cnf

# 9. Clean up CSR files
echo "9. Cleaning up CSR files..."
rm -f server.csr client.csr

# 10. Set appropriate permissions
echo "10. Setting permissions..."
chmod 600 *.key
chmod 644 *.crt

echo ""
echo "mTLS certificates generated successfully!"
echo ""
echo "Files created:"
echo "  - ca.crt (CA certificate)"
echo "  - ca.key (CA private key)"
echo "  - server.crt (Server certificate)"
echo "  - server.key (Server private key)"
echo "  - client.crt (Client certificate)"
echo "  - client.key (Client private key)"
echo ""
echo "To verify certificates:"
echo "  openssl verify -CAfile ca.crt server.crt"
echo "  openssl verify -CAfile ca.crt client.crt"
