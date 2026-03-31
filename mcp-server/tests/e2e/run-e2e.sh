#!/bin/bash
set -euo pipefail

# ============================================================
# Run E2E Claude Code ↔ MCP Server tests
#
# Usage:
#   ./tests/e2e/run-e2e.sh                          # test against localhost:8081
#   ./tests/e2e/run-e2e.sh https://adhdbudget.bieda.it/mcp  # test against production
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MCP_URL="${1:-http://host.docker.internal:8081/mcp}"
RESULTS_DIR="$PROJECT_DIR/tests/e2e/results"

echo "=== Building E2E test container ==="
docker build -t claude-mcp-e2e \
  -f "$SCRIPT_DIR/Dockerfile.claude-test" \
  "$PROJECT_DIR"

echo ""
echo "=== Running E2E tests against: $MCP_URL ==="
mkdir -p "$RESULTS_DIR"

docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -v "$HOME/.claude:/home/tester/.claude" \
  -v "$RESULTS_DIR:/home/tester/results" \
  -e "MCP_SERVER_URL=$MCP_URL" \
  -e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}" \
  claude-mcp-e2e

echo ""
echo "=== Results ==="
cat "$RESULTS_DIR/summary.json" 2>/dev/null | python3 -m json.tool || true
