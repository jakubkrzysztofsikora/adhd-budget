# Log Viewer Service

The log-viewer service provides secure HTTP access to MCP server logs with mTLS (mutual TLS) authentication.

## Architecture

```
┌─────────────┐      Shared Volume      ┌─────────────┐
│ MCP Server  │ ─────────────────────> │ Log Viewer  │
│             │   /var/log/mcp/*.log   │   Service   │
└─────────────┘                         └──────┬──────┘
                                               │
                                               │ mTLS
                                               │ (port 8888)
                                               ▼
                                         ┌──────────────┐
                                         │   Client     │
                                         │ (with certs) │
                                         └──────────────┘
```

## Features

- **mTLS Authentication**: Secure access using client certificates
- **Multiple Endpoints**:
  - `/health` - Health check endpoint
  - `/logs` - JSON format with metadata
  - `/logs/stream` - Plain text format (easier to read)
  - `/logs/<filename>` - Access specific log file
- **Security**: Read-only access, non-root container, capability dropping
- **Resource Limits**: 128MB memory, 0.25 CPU

## Setup

### 1. Generate mTLS Certificates

Run the certificate generation script:

```bash
cd certs
bash generate-mtls-certs.sh
```

This creates:
- `ca.crt` / `ca.key` - Certificate Authority
- `server.crt` / `server.key` - Server certificate for log-viewer
- `client.crt` / `client.key` - Client certificate for accessing logs

### 2. Verify Certificates

```bash
cd certs
openssl verify -CAfile ca.crt server.crt
openssl verify -CAfile ca.crt client.crt
```

### 3. Start Services

```bash
docker compose up -d log-viewer
```

## Usage

### Access Logs with curl

**Health Check** (no mTLS required for health endpoint when in insecure mode):
```bash
curl https://localhost:8888/health \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key
```

**Get Logs (JSON format)**:
```bash
curl https://localhost:8888/logs \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key
```

**Get Logs (Plain Text, easier to read)**:
```bash
curl https://localhost:8888/logs/stream \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key
```

**Get Specific Log File**:
```bash
curl https://localhost:8888/logs/mcp-server.log \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key
```

### Example: Save Logs to File

```bash
curl https://localhost:8888/logs/stream \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key \
  --output mcp-logs-$(date +%Y%m%d-%H%M%S).txt
```

### Example: Watch Logs (Polling)

```bash
watch -n 5 "curl -s https://localhost:8888/logs/stream \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key | tail -50"
```

## Endpoints

### GET /health

Returns service health status (JSON):

```json
{
  "status": "healthy",
  "service": "log-viewer",
  "timestamp": "2024-01-01T12:00:00.000000"
}
```

### GET /logs

Returns all log files with metadata (JSON):

```json
{
  "log_dir": "/var/log/mcp",
  "timestamp": "2024-01-01T12:00:00.000000",
  "logs": {
    "mcp-server.log": {
      "lines": ["log line 1", "log line 2", "..."],
      "total_lines": 1500,
      "size_bytes": 125000,
      "modified": "2024-01-01T11:59:00.000000"
    }
  }
}
```

### GET /logs/stream

Returns all logs in plain text format:

```
================================================================================
LOG FILE: mcp-server.log
SIZE: 125000 bytes
MODIFIED: 2024-01-01T11:59:00.000000
================================================================================

2024-01-01 12:00:00 - INFO - Starting MCP server...
2024-01-01 12:00:01 - INFO - Connected to database
...
```

### GET /logs/<filename>

Returns specific log file content in plain text.

## Security

### mTLS Configuration

The service uses mutual TLS authentication:

1. **Server Side**:
   - Server certificate signed by CA
   - Requires client certificate for all requests
   - `CERT_REQUIRED` mode

2. **Client Side**:
   - Must present valid client certificate
   - Must trust the CA certificate
   - Certificate chain verified

### Container Security

- Runs as non-root user (uid 1000)
- All capabilities dropped
- Read-only access to log volume
- Memory and CPU limits enforced
- No privileged operations

## Troubleshooting

### Service won't start

Check if certificates exist:
```bash
ls -la certs/
```

If missing, regenerate:
```bash
cd certs && bash generate-mtls-certs.sh
```

### "Connection refused" error

Check if service is running:
```bash
docker compose ps log-viewer
```

Check logs:
```bash
docker compose logs log-viewer
```

### "SSL certificate problem" error

Verify certificates:
```bash
cd certs
openssl verify -CAfile ca.crt client.crt
openssl x509 -in client.crt -text -noout
```

### No logs appearing

Check if MCP server is writing logs:
```bash
docker compose logs mcp-server
docker compose exec mcp-server ls -la /var/log/mcp/
```

Verify volume mount:
```bash
docker volume inspect adhd_budget_mcp_logs
```

### Insecure Mode (Development Only)

If certificates are missing, the service will start in insecure HTTP mode:

```bash
# Access without certificates (development only!)
curl http://localhost:8888/health
curl http://localhost:8888/logs/stream
```

**WARNING**: Insecure mode should never be used in production.

## Monitoring

### Check Service Health

```bash
# Using curl with mTLS
curl https://localhost:8888/health \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key

# Using docker healthcheck
docker compose ps log-viewer
```

### View Service Logs

```bash
# View log-viewer service logs (not MCP logs)
docker compose logs -f log-viewer
```

### Check Certificate Expiration

```bash
cd certs
openssl x509 -in server.crt -noout -dates
openssl x509 -in client.crt -noout -dates
```

Certificates are valid for 365 days. Regenerate before expiration.

## Integration with Monitoring Tools

### Prometheus Metrics (Future)

The service can be extended to expose Prometheus metrics:
- Log file sizes
- Number of log lines
- Last log update timestamp
- Certificate expiration date

### Log Aggregation (Future)

The service can be integrated with:
- ELK Stack (Elasticsearch, Logstash, Kibana)
- Grafana Loki
- Splunk
- Datadog

## Configuration

Environment variables (set in docker-compose.yml):

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_DIR` | `/var/log/mcp` | Directory containing log files |
| `LOG_VIEWER_PORT` | `8888` | Port to listen on |
| `CERT_FILE` | `/app/certs/server.crt` | Server certificate path |
| `KEY_FILE` | `/app/certs/server.key` | Server private key path |
| `CA_FILE` | `/app/certs/ca.crt` | CA certificate path |

## Development

### Testing Locally

```bash
# Build and start
docker compose up -d log-viewer

# Check health
curl -k https://localhost:8888/health \
  --cert certs/client.crt \
  --key certs/client.key \
  --cacert certs/ca.crt

# View logs
curl -k https://localhost:8888/logs/stream \
  --cert certs/client.crt \
  --key certs/client.key \
  --cacert certs/ca.crt
```

### Running Without Docker

```bash
# Install dependencies
pip3 install -r requirements.txt

# Set environment
export LOG_DIR=./logs
export LOG_VIEWER_PORT=8888
export CERT_FILE=./certs/server.crt
export KEY_FILE=./certs/server.key
export CA_FILE=./certs/ca.crt

# Create test logs
mkdir -p logs
echo "Test log entry" > logs/mcp-server.log

# Run service
python3 src/log_viewer.py
```

## Gate Compliance

This log-viewer service supports the following validation gates:

- **I1 (Observability)**: Provides centralized log access
- **S2 (TLS Implementation)**: Uses mTLS for secure communication
- **S3 (Access Control)**: Requires client certificate authentication
- **S4 (Container Hardening)**: Non-root user, capability dropping, resource limits

## References

- [OpenSSL Certificate Generation](https://www.openssl.org/docs/man1.1.1/man1/openssl-req.html)
- [Python SSL Module](https://docs.python.org/3/library/ssl.html)
- [Docker Compose Volumes](https://docs.docker.com/compose/compose-file/compose-file-v3/#volumes)
- [mTLS Best Practices](https://www.cloudflare.com/learning/access-management/what-is-mutual-tls/)
