# Log Viewer Quick Start

This document provides a quick guide to accessing MCP server logs via the log-viewer service.

## Overview

The log-viewer service provides HTTP access to MCP server logs with optional mTLS authentication.

```
MCP Server → Logs to /var/log/mcp/mcp-server.log
                 ↓
         (shared volume)
                 ↓
         Log Viewer Service → HTTP API (port 8888)
                 ↓
         Client (curl/browser)
```

## Quick Access (Development Mode - No Certificates Required)

The service automatically runs in insecure HTTP mode if certificates are not present:

### Check Health
```bash
curl http://localhost:8888/health
```

### View All Logs (Plain Text)
```bash
curl http://localhost:8888/logs/stream
```

### View All Logs (JSON)
```bash
curl http://localhost:8888/logs
```

### View Specific Log File
```bash
curl http://localhost:8888/logs/mcp-server.log
```

### Save Logs to File
```bash
curl http://localhost:8888/logs/stream -o mcp-logs-$(date +%Y%m%d-%H%M%S).txt
```

## Production Mode (With mTLS)

For production deployment with mTLS authentication:

### 1. Generate Certificates

```bash
# Automated generation
bash scripts/generate-log-viewer-certs.sh

# Manual generation
cd certs
bash generate-mtls-certs.sh
```

### 2. Access with mTLS

```bash
# Health check
curl https://localhost:8888/health \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key

# View logs
curl https://localhost:8888/logs/stream \
  --cacert certs/ca.crt \
  --cert certs/client.crt \
  --key certs/client.key
```

## Available Endpoints

| Endpoint | Description | Format |
|----------|-------------|---------|
| `/health` | Service health check | JSON |
| `/logs` | All logs with metadata | JSON |
| `/logs/stream` | All logs (plain text) | Text |
| `/logs/<filename>` | Specific log file | Text |

## Example Outputs

### Health Check (`/health`)
```json
{
  "status": "healthy",
  "service": "log-viewer",
  "timestamp": "2024-01-01T12:00:00.000000"
}
```

### Logs Stream (`/logs/stream`)
```
================================================================================
LOG FILE: mcp-server.log
SIZE: 125000 bytes
MODIFIED: 2024-01-01T11:59:00.000000
================================================================================

2024-01-01 12:00:00,123 - adhd_budget.mcp - INFO - Logging to /var/log/mcp/mcp-server.log
2024-01-01 12:00:00,124 - adhd_budget.mcp - INFO - Starting MCP server...
2024-01-01 12:00:01,456 - adhd_budget.mcp - INFO - Connected to database
2024-01-01 12:00:02,789 - adhd_budget.mcp - INFO - Server ready
...
```

### Logs JSON (`/logs`)
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

## Troubleshooting

### Service not responding

Check if service is running:
```bash
docker compose ps log-viewer
```

Start if not running:
```bash
docker compose up -d log-viewer
```

### No logs appearing

Check if MCP server is running:
```bash
docker compose ps mcp-server
```

Verify MCP server is logging:
```bash
docker compose logs mcp-server | grep "Logging to"
```

### Certificate errors (mTLS mode)

Regenerate certificates:
```bash
bash scripts/generate-log-viewer-certs.sh
docker compose restart log-viewer
```

## Advanced Usage

### Watch logs in real-time
```bash
watch -n 5 "curl -s http://localhost:8888/logs/stream | tail -50"
```

### Filter logs with grep
```bash
curl -s http://localhost:8888/logs/stream | grep "ERROR"
```

### Save and analyze logs
```bash
# Save logs
curl -s http://localhost:8888/logs/stream > mcp-logs.txt

# Analyze
grep "ERROR" mcp-logs.txt | wc -l  # Count errors
grep "INFO" mcp-logs.txt | tail -20  # Last 20 info messages
```

## Service Configuration

The log-viewer service is configured in `docker-compose.yml`:

- **Port**: 8888
- **Log Directory**: `/var/log/mcp` (shared with MCP server)
- **Certificates**: `./certs` directory (mounted read-only)
- **Resources**: 128MB memory, 0.25 CPU
- **Security**: Non-root user, capabilities dropped

## Documentation

- **Setup Guide**: [docs/SETUP_LOG_VIEWER.md](docs/SETUP_LOG_VIEWER.md)
- **Full API Docs**: [docs/LOG_VIEWER.md](docs/LOG_VIEWER.md)
- **Certificate README**: [certs/README.md](certs/README.md)
- **Project Spec**: [CLAUDE.md](CLAUDE.md)

## Security Notes

### Development Mode (HTTP)
- No authentication required
- Suitable for local development only
- Automatically enabled when certificates are missing
- **Do NOT use in production**

### Production Mode (HTTPS with mTLS)
- Requires client certificate
- All traffic encrypted
- Mutual authentication (server and client)
- Use for production deployments

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review [docs/LOG_VIEWER.md](docs/LOG_VIEWER.md)
3. Check service logs: `docker compose logs log-viewer`
4. Check MCP server logs: `docker compose logs mcp-server`
