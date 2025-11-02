# mTLS Certificates for Log Viewer

This directory contains the mTLS certificates used to secure the log-viewer service.

## Quick Start

Generate certificates:
```bash
bash generate-mtls-certs.sh
```

## Certificate Files

After generation, you'll have:

- `ca.crt` - Certificate Authority (CA) certificate (can be committed)
- `ca.key` - CA private key (**DO NOT COMMIT** - in .gitignore)
- `ca.srl` - CA serial number file
- `server.crt` - Server certificate for log-viewer service (can be committed)
- `server.key` - Server private key (**DO NOT COMMIT** - in .gitignore)
- `client.crt` - Client certificate for accessing logs (can be committed)
- `client.key` - Client private key (**DO NOT COMMIT** - in .gitignore)

## Security Notes

- Private keys (*.key) are automatically excluded by .gitignore
- Never commit private keys to version control
- Certificates are valid for 365 days (server/client) or 10 years (CA)
- Regenerate certificates before expiration

## Configuration Files

- `openssl-ca.cnf` - CA certificate configuration
- `openssl-server.cnf` - Server certificate configuration
- `openssl-client.cnf` - Client certificate configuration
- `generate-mtls-certs.sh` - Automated certificate generation script

## Verification

Check certificate validity:
```bash
# Verify server certificate
openssl verify -CAfile ca.crt server.crt

# Verify client certificate
openssl verify -CAfile ca.crt client.crt

# Check certificate details
openssl x509 -in server.crt -text -noout

# Check expiration dates
openssl x509 -in server.crt -noout -dates
```

## Usage

See [LOG_VIEWER.md](../docs/LOG_VIEWER.md) for complete usage instructions.

Quick test:
```bash
curl https://localhost:8888/health \
  --cacert ca.crt \
  --cert client.crt \
  --key client.key
```

## Troubleshooting

If you get certificate errors:

1. Verify files exist and have correct permissions:
   ```bash
   ls -la *.crt *.key
   ```

2. Check certificate chain:
   ```bash
   openssl verify -CAfile ca.crt server.crt
   openssl verify -CAfile ca.crt client.crt
   ```

3. Regenerate if needed:
   ```bash
   bash generate-mtls-certs.sh
   ```

## Certificate Renewal

When certificates approach expiration:

1. Backup existing certificates
2. Regenerate certificates: `bash generate-mtls-certs.sh`
3. Restart log-viewer service: `docker compose restart log-viewer`
4. Distribute new client certificates to authorized users
