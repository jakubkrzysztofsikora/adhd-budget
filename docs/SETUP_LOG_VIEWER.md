# Log Viewer Setup Guide

Quick guide to set up the log-viewer service with mTLS authentication.

## Prerequisites

- Docker and Docker Compose installed
- OpenSSL installed (check with `openssl version`)

## Step 1: Generate mTLS Certificates

Run the automated certificate generation script:

```bash
bash scripts/generate-log-viewer-certs.sh
```

**Manual Generation** (if script fails):

```bash
cd certs

# 1. Generate CA
openssl genrsa -out ca.key 2048
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
    -out ca.crt -config openssl-ca.cnf

# 2. Generate Server Certificate
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr -config openssl-server.cnf
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out server.crt -days 365 -sha256 -extensions v3_req -extfile openssl-server.cnf

# 3. Generate Client Certificate
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr -config openssl-client.cnf
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out client.crt -days 365 -sha256 -extensions v3_req -extfile openssl-client.cnf

# 4. Clean up and set permissions
rm -f server.csr client.csr
chmod 600 *.key
chmod 644 *.crt
```

Verify certificates:
```bash
openssl verify -CAfile ca.crt server.crt
openssl verify -CAfile ca.crt client.crt
```

## Step 2: Start the Service

```bash
# Build the service
docker compose build log-viewer

# Start the service
docker compose up -d log-viewer

# Check if it's running
docker compose ps log-viewer
```

## Step 3: Test the Service

### Health Check

```bash
curl https://localhost:8888/health \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key
```

Expected response:
```json
{
  "status": "healthy",
  "service": "log-viewer",
  "timestamp": "2024-01-01T12:00:00.000000"
}
```

### View Logs (Plain Text)

```bash
curl https://localhost:8888/logs/stream \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key
```

### View Logs (JSON)

```bash
curl https://localhost:8888/logs \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key | jq
```

### View Specific Log File

```bash
curl https://localhost:8888/logs/mcp-server.log \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key
```

## Step 4: Integration with MCP Server

The MCP server automatically logs to `/var/log/mcp/mcp-server.log` when running in the container. The log-viewer service reads from this shared volume.

To verify MCP server is logging:
```bash
# Check MCP server logs
docker compose logs mcp-server

# Check log files in shared volume
docker compose exec mcp-server ls -la /var/log/mcp/
```

## Development Mode (Without mTLS)

If certificates are not present, the service runs in insecure HTTP mode:

```bash
# Access without certificates (insecure)
curl http://localhost:8888/health
curl http://localhost:8888/logs/stream
```

**WARNING**: This mode is for development only. Always use mTLS in production.

## Troubleshooting

### "Connection refused"

Check service status:
```bash
docker compose ps log-viewer
docker compose logs log-viewer
```

### "SSL certificate problem"

Verify certificates exist and are valid:
```bash
ls -la certs/*.crt certs/*.key
openssl verify -CAfile certs/ca.crt certs/server.crt
openssl verify -CAfile certs/ca.crt certs/client.crt
```

Regenerate if needed:
```bash
bash scripts/generate-log-viewer-certs.sh
docker compose restart log-viewer
```

### No logs appearing

Check MCP server is running and logging:
```bash
docker compose ps mcp-server
docker compose logs mcp-server | grep "Logging to"
docker compose exec mcp-server ls -la /var/log/mcp/
```

Check volume mount:
```bash
docker volume inspect adhd_budget_mcp_logs
```

### Permission errors

Check file permissions:
```bash
ls -la certs/
# Keys should be 600, certificates 644
```

## Useful Commands

### Save logs to file
```bash
curl https://localhost:8888/logs/stream \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key \
  --output "mcp-logs-$(date +%Y%m%d-%H%M%S).txt"
```

### Watch logs (polling every 5 seconds)
```bash
watch -n 5 "curl -s https://localhost:8888/logs/stream \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key | tail -50"
```

### Check certificate expiration
```bash
openssl x509 -in certs/server.crt -noout -dates
openssl x509 -in certs/client.crt -noout -dates
```

## Production Deployment

1. Generate strong certificates (as shown above)
2. Set proper file permissions (600 for keys, 644 for certificates)
3. Never commit private keys to version control
4. Set up certificate rotation before expiration (365 days)
5. Monitor certificate expiration dates
6. Use environment variables for sensitive configuration
7. Enable Docker logging with rotation
8. Set up alerts for service health failures

## Next Steps

- See [LOG_VIEWER.md](LOG_VIEWER.md) for complete API documentation
- See [CLAUDE.md](../CLAUDE.md) for project architecture
- Check validation gates in testing protocol
