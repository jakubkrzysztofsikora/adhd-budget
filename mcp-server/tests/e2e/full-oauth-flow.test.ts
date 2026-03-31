/**
 * Full OAuth E2E Test — tests the complete token lifecycle
 *
 * Since bank auth requires a browser, this test:
 *   1. Registers a client via DCR
 *   2. Verifies /authorize redirects to Enable Banking
 *   3. Injects a test session directly into the server's session store
 *   4. Uses the token to call /mcp — initialize, list tools, invoke tool
 *   5. Tests token revocation
 *
 * This validates the entire OAuth + MCP flow except the browser-based bank login.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const TEST_PORT = 8081;  // Must match Enable Banking registered redirect URL
const BASE_URL = `http://localhost:${TEST_PORT}`;
const DATA_DIR = './data/e2e-test';

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function waitForHealthy(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server not healthy within ${timeoutMs}ms`);
}

async function sseToJson(response: Response): Promise<unknown> {
  const text = await response.text();
  const dataLine = text.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) throw new Error(`No SSE data in response: ${text.substring(0, 200)}`);
  return JSON.parse(dataLine.replace('data: ', ''));
}

describe('Full OAuth + MCP Tool Invocation E2E', () => {
  let serverProcess: ChildProcess;
  let testAccessToken: string;

  beforeAll(async () => {
    const keyPath = process.env.ENABLE_PRIVATE_KEY_PATH || '../keys/enablebanking_private.pem';
    const appId = process.env.ENABLE_APP_ID || '';

    if (!appId) {
      throw new Error('ENABLE_APP_ID is required. Set ENABLE_APP_ID and ENABLE_PRIVATE_KEY_PATH env vars to run E2E tests.');
    }

    const { mkdirSync } = await import('node:fs');
    mkdirSync(DATA_DIR, { recursive: true });

    // Start MCP server with a known data directory so we can inject sessions

    serverProcess = spawn('node', ['dist/index.js'], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        HOST: '127.0.0.1',
        ENABLE_APP_ID: appId || undefined,
        ENABLE_PRIVATE_KEY_PATH: appId ? keyPath : undefined,
        ENABLE_API_BASE_URL: 'https://api.enablebanking.com',
        EXTERNAL_URL: `http://localhost:${TEST_PORT}`,
        ASPSP_NAME: 'Nordea',
        ASPSP_COUNTRY: 'FI',
        DATA_DIR: DATA_DIR,
        LOG_LEVEL: 'silent',
      },
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    await waitForHealthy(BASE_URL);

    // Inject a test token directly into the server's session store DB
    testAccessToken = generateToken();
    const db = new Database(`${DATA_DIR}/sessions.db`);
    db.prepare(
      'INSERT OR REPLACE INTO sessions (token_hash, eb_session_id, account_uids, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      hashToken(testAccessToken),
      'e2e-test-session',
      JSON.stringify(['e2e-account-1', 'e2e-account-2']),
      Date.now(),
      Date.now() + 3600_000,
    );
    db.close();
  }, 20000);

  afterAll(async () => {
    serverProcess?.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (serverProcess) serverProcess.on('exit', () => resolve());
      else resolve();
      setTimeout(resolve, 2000);
    });
    // Cleanup test data
    const { rmSync } = await import('node:fs');
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('Step 1: DCR registers client with redirect_uri validation', async () => {
    // Should reject evil redirect URIs
    const evilRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://evil.com/steal'],
        client_name: 'Evil', token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], response_types: ['code'],
      }),
    });
    expect(evilRes.status).toBe(400);

    // Should accept Claude's redirect URI
    const goodRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        client_name: 'Claude', token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], response_types: ['code'],
      }),
    });
    expect(goodRes.status).toBe(201);
    const client = await goodRes.json() as { client_id: string };
    expect(client.client_id).toBeTruthy();
  });

  it('Step 2: /authorize redirects to Enable Banking', async () => {
    // Use a redirect_uri that's registered in Enable Banking
    const callbackUri = `http://localhost:${TEST_PORT}/auth/eb-callback`;
    const dcrRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://localhost:9999/callback'],
        client_name: 'Test', token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], response_types: ['code'],
      }),
    });
    const client = await dcrRes.json() as { client_id: string };

    const codeVerifier = generateToken();
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const authRes = await fetch(
      `${BASE_URL}/authorize?client_id=${client.client_id}&redirect_uri=http://localhost:9999/callback&response_type=code&code_challenge=${codeChallenge}&code_challenge_method=S256&state=test-state`,
      { redirect: 'manual' },
    );

    expect(authRes.status).toBe(302);
    const location = authRes.headers.get('location')!;

    if (process.env.ENABLE_APP_ID) {
      // With EB credentials: should redirect to bank
      expect(location).toContain('enablebanking.com');
    } else {
      // Without EB credentials: error redirect
      expect(location).toContain('error');
    }
  });

  it('Step 3: /mcp returns 401 with correct WWW-Authenticate header', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
        id: 1,
      }),
    });

    if (process.env.ENABLE_APP_ID) {
      expect(res.status).toBe(401);
      const wwwAuth = res.headers.get('www-authenticate');
      expect(wwwAuth).toContain('Bearer');
      expect(wwwAuth).toContain('resource_metadata');
      expect(wwwAuth).toContain('.well-known/oauth-protected-resource');
    }
  });

  it('Step 4: Initialize MCP session with valid token', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${testAccessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e-test', version: '1.0' },
        },
        id: 1,
      }),
    });

    expect(res.status).toBe(200);
    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const data = await sseToJson(res) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(data.result.protocolVersion).toBe('2025-06-18');
    expect(data.result.serverInfo.name).toContain('enable-banking');
  });

  it('Step 5: List tools via authenticated MCP session', async () => {
    // Initialize first
    const initRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${testAccessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0' } },
        id: 1,
      }),
    });
    const sessionId = initRes.headers.get('mcp-session-id')!;

    // Send initialized notification
    await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${testAccessToken}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    // List tools
    const toolsRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${testAccessToken}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
    });

    expect(toolsRes.status).toBe(200);
    const data = await sseToJson(toolsRes) as { result: { tools: Array<{ name: string }> } };
    const toolNames = data.result.tools.map(t => t.name);
    expect(toolNames).toContain('accounts');
    expect(toolNames).toContain('balances');
    expect(toolNames).toContain('transactions');
    expect(toolNames).toContain('search');
    expect(toolNames).toContain('transaction');
    expect(toolNames).toHaveLength(5);
  });

  it('Step 6: Invoke tool via authenticated MCP session', async () => {
    // Initialize
    const initRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${testAccessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0' } },
        id: 1,
      }),
    });
    const sessionId = initRes.headers.get('mcp-session-id')!;

    await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${testAccessToken}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    // Call the accounts tool
    const toolRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${testAccessToken}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'tools/call',
        params: { name: 'accounts', arguments: {} },
        id: 3,
      }),
    });

    expect(toolRes.status).toBe(200);
    const data = await sseToJson(toolRes) as { result: { content: Array<{ type: string; text: string }> } };
    expect(data.result.content).toHaveLength(1);
    expect(data.result.content[0].type).toBe('text');
    // The tool will try to call EB API with our fake session ID, which will error
    // but should return a proper MCP error response (not crash)
    const text = data.result.content[0].text;
    expect(text).toBeTruthy();
  });

  it('Step 7: Reject expired tokens', async () => {
    // Insert an expired token
    const expiredToken = generateToken();
    const db = new Database(`${DATA_DIR}/sessions.db`);
    db.prepare(
      'INSERT INTO sessions (token_hash, eb_session_id, account_uids, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(hashToken(expiredToken), 'expired-session', '[]', Date.now() - 7200_000, Date.now() - 3600_000);
    db.close();

    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${expiredToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
        id: 1,
      }),
    });
    expect(res.status).toBe(401);
  });

  it('Step 8: Token revocation invalidates access', async () => {
    // Create a token to revoke
    const tokenToRevoke = generateToken();
    const db = new Database(`${DATA_DIR}/sessions.db`);
    db.prepare(
      'INSERT INTO sessions (token_hash, eb_session_id, account_uids, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(hashToken(tokenToRevoke), 'revoke-session', '["acc-1"]', Date.now(), Date.now() + 3600_000);
    db.close();

    // Verify token works first
    const beforeRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${tokenToRevoke}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
        id: 1,
      }),
    });
    expect(beforeRes.status).toBe(200);

    // Register a client for revocation
    const dcrRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://localhost:3000/callback'],
        client_name: 'Revoker', token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], response_types: ['code'],
      }),
    });
    const client = await dcrRes.json() as { client_id: string };

    // Revoke the token
    const revokeRes = await fetch(`${BASE_URL}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: tokenToRevoke,
        client_id: client.client_id,
      }).toString(),
    });
    expect(revokeRes.status).toBe(200);

    // Token should now be rejected
    const afterRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${tokenToRevoke}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
        id: 1,
      }),
    });
    expect(afterRes.status).toBe(401);
  });
});
