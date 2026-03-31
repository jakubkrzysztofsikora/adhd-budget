/**
 * Full OAuth + MCP E2E Test
 *
 * Real end-to-end flow:
 *   1. Start MCP server
 *   2. DCR — register client
 *   3. Authorize — get bank redirect URL
 *   4. Playwright — automate Nordea sandbox login (auto-completes, no credentials)
 *   5. Capture callback — extract MCP authorization code
 *   6. Token exchange — PKCE verified, get real MCP access token
 *   7. MCP protocol — initialize session, list tools, invoke tool with Bearer token
 *   8. Claude Code CLI — `claude --bare -p` with the token to actually use MCP tools
 *   9. Token lifecycle — expiry rejection, revocation
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn, execSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { chromium, type Browser } from 'playwright';
import Database from 'better-sqlite3';

const PORT = 8081;
const BASE_URL = `http://localhost:${PORT}`;
const CALLBACK_PORT = 19876;
const DATA_DIR = './data/e2e-test';

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

describe('Full OAuth + MCP E2E', () => {
  let serverProcess: ChildProcess;
  let browser: Browser;
  let callbackServer: HttpServer;

  // These get populated as we go through the flow
  let clientId: string;
  let codeVerifier: string;
  let codeChallenge: string;
  let mcpAuthCode: string;
  let mcpAccessToken: string;
  let mcpRefreshToken: string;
  let mcpSessionId: string;

  const appId = process.env.ENABLE_APP_ID;
  const keyPath = process.env.ENABLE_PRIVATE_KEY_PATH || '../keys/enablebanking_private.pem';

  beforeAll(async () => {
    if (!appId) {
      throw new Error(
        'ENABLE_APP_ID is required. Run with:\n' +
        '  ENABLE_APP_ID=1ba6d8a6-68f8-4899-b0a4-c8d8a795337b ENABLE_PRIVATE_KEY_PATH=../keys/enablebanking_private.pem npm run test:e2e',
      );
    }

    mkdirSync(DATA_DIR, { recursive: true });

    // Start MCP server
    serverProcess = spawn('node', ['dist/index.js'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        ENABLE_APP_ID: appId,
        ENABLE_PRIVATE_KEY_PATH: keyPath,
        ENABLE_API_BASE_URL: 'https://api.enablebanking.com',
        EXTERNAL_URL: BASE_URL,
        ASPSP_NAME: 'Nordea',
        ASPSP_COUNTRY: 'FI',
        DATA_DIR,
        LOG_LEVEL: 'silent',
      },
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    await waitForHealthy(BASE_URL);

    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    callbackServer?.close();
    serverProcess?.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (serverProcess) serverProcess.on('exit', () => resolve());
      else resolve();
      setTimeout(resolve, 3000);
    });
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  // ---- Step 1: DCR ----
  it('1. DCR registers client, rejects evil redirect URIs', async () => {
    const evilRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://evil.com/steal'],
        client_name: 'Evil',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      }),
    });
    expect(evilRes.status).toBe(400);

    const goodRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [`http://localhost:${CALLBACK_PORT}/callback`],
        client_name: 'E2E Test',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      }),
    });
    expect(goodRes.status).toBe(201);
    const client = (await goodRes.json()) as { client_id: string };
    expect(client.client_id).toBeTruthy();
    clientId = client.client_id;
  });

  // ---- Step 2: Generate PKCE + authorize ----
  it('2. /authorize redirects to Enable Banking → Nordea', async () => {
    codeVerifier = randomBytes(32).toString('base64url');
    codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const authRes = await fetch(
      `${BASE_URL}/authorize?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: `http://localhost:${CALLBACK_PORT}/callback`,
          response_type: 'code',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state: 'e2e-state',
        }).toString(),
      { redirect: 'manual' },
    );
    expect(authRes.status).toBe(302);
    const location = authRes.headers.get('location')!;
    expect(location).toContain('enablebanking.com');
  });

  // ---- Step 3: Playwright automates bank login + captures callback ----
  it('3. Playwright completes Nordea sandbox auth, captures MCP auth code', async () => {
    // Start callback server to capture the redirect from our /auth/eb-callback
    const callbackReceived = new Promise<{ code: string; state: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Callback timeout after 30s')), 30000);
      callbackServer = createServer((req, res) => {
        const url = new URL(req.url!, `http://localhost:${CALLBACK_PORT}`);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        if (error) {
          clearTimeout(timeout);
          res.writeHead(200);
          res.end('Error received');
          reject(new Error(`OAuth error: ${error} — ${url.searchParams.get('error_description')}`));
          return;
        }
        if (code && state) {
          clearTimeout(timeout);
          res.writeHead(200);
          res.end('OK');
          resolve({ code, state });
        }
      });
      callbackServer.listen(CALLBACK_PORT);
    });

    // Get a fresh auth URL
    const authRes = await fetch(
      `${BASE_URL}/authorize?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: `http://localhost:${CALLBACK_PORT}/callback`,
          response_type: 'code',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state: 'e2e-state',
        }).toString(),
      { redirect: 'manual' },
    );
    const bankUrl = authRes.headers.get('location')!;

    // Playwright: navigate to bank, click consent, wait for auto-redirect
    const page = await browser.newPage();
    await page.goto(bankUrl, { waitUntil: 'networkidle', timeout: 15000 });

    // Click "Continue authentication" consent button
    const continueBtn = page.locator('button').first();
    await continueBtn.click();

    // Nordea sandbox auto-completes — wait for redirect to our callback
    await page.waitForURL(
      url => url.toString().includes(`localhost:${CALLBACK_PORT}`),
      { timeout: 30000 },
    );
    await page.close();

    // Get the auth code from the callback
    const callback = await callbackReceived;
    expect(callback.code).toBeTruthy();
    expect(callback.state).toBe('e2e-state');
    mcpAuthCode = callback.code;
    callbackServer.close();
  }, 45000);

  // ---- Step 4: Token exchange with PKCE ----
  it('4. Token exchange returns access + refresh token', async () => {
    const tokenRes = await fetch(`${BASE_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: mcpAuthCode,
        code_verifier: codeVerifier,
        client_id: clientId,
        redirect_uri: `http://localhost:${CALLBACK_PORT}/callback`,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
    mcpAccessToken = tokens.access_token;
    mcpRefreshToken = tokens.refresh_token;
  });

  // ---- Step 5: Initialize MCP session with real token ----
  it('5. MCP initialize succeeds with real Bearer token', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${mcpAccessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e-real', version: '1.0' },
        },
        id: 1,
      }),
    });
    expect(res.status).toBe(200);
    mcpSessionId = res.headers.get('mcp-session-id')!;
    expect(mcpSessionId).toBeTruthy();

    const data = (await sseToJson(res)) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(data.result.protocolVersion).toBe('2025-06-18');
    expect(data.result.serverInfo.name).toContain('enable-banking');

    // Send initialized notification
    await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${mcpAccessToken}`,
        'mcp-session-id': mcpSessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  });

  // ---- Step 6: List tools ----
  it('6. tools/list returns all 5 banking tools', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${mcpAccessToken}`,
        'mcp-session-id': mcpSessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
    });
    expect(res.status).toBe(200);
    const data = (await sseToJson(res)) as { result: { tools: Array<{ name: string; description: string }> } };
    const names = data.result.tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['accounts', 'balances', 'transactions', 'search', 'transaction']));
    expect(names).toHaveLength(5);
  });

  // ---- Step 7: Invoke tool with real EB session ----
  it('7. tools/call accounts returns real bank data from Nordea sandbox', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${mcpAccessToken}`,
        'mcp-session-id': mcpSessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'accounts', arguments: {} },
        id: 3,
      }),
    });
    expect(res.status).toBe(200);
    const data = (await sseToJson(res)) as { result: { content: Array<{ type: string; text: string }> } };
    expect(data.result.content).toHaveLength(1);
    expect(data.result.content[0].type).toBe('text');

    // Parse the tool response — should contain real Nordea sandbox accounts
    const toolOutput = JSON.parse(data.result.content[0].text);
    expect(toolOutput).toHaveProperty('accounts');
    // Nordea sandbox returns real account data
    if (toolOutput.accounts && Array.isArray(toolOutput.accounts) && toolOutput.accounts.length > 0) {
      console.log(`    Got ${toolOutput.accounts.length} real Nordea sandbox accounts`);
    }
  });

  // ---- Step 8: Claude Code CLI uses the MCP tools ----
  it('8. Claude Code CLI invokes MCP tools via --bare -p', async () => {
    // Check if claude is available
    try {
      execSync('claude --version', { stdio: 'pipe' });
    } catch {
      console.log('    claude CLI not available — skipping CLI test');
      return;
    }

    const mcpConfig = JSON.stringify({
      mcpServers: {
        'nordea-e2e': {
          type: 'http',
          url: `${BASE_URL}/mcp`,
          headers: { Authorization: `Bearer ${mcpAccessToken}` },
        },
      },
    });

    // claude --bare requires ANTHROPIC_API_KEY (skips keychain)
    // Without --bare, claude picks up ~/.claude auth automatically
    const usesBare = !!process.env.ANTHROPIC_API_KEY;
    const bareFlag = usesBare ? '--bare ' : '';

    const result = execSync(
      `claude ${bareFlag}-p "Call the accounts tool from the nordea-e2e MCP server and return the raw result. Do not explain, just return tool output." ` +
        `--mcp-config '${mcpConfig}' ` +
        `--allowedTools "mcp__nordea-e2e__*" ` +
        `--max-turns 3 ` +
        `--output-format json`,
      { timeout: 120000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const output = JSON.parse(result);
    expect(output.is_error).toBeFalsy();
    expect(output.result).toBeTruthy();
    console.log('    Claude CLI response:', output.result.substring(0, 300));
  }, 90000);

  // ---- Step 9: Token lifecycle ----
  it('9. Expired tokens rejected, revocation works', async () => {
    // Wait for server to stabilize after Claude CLI test
    await new Promise(r => setTimeout(r, 1000));
    // Inject an expired token directly into the server's DB
    const expiredToken = randomBytes(32).toString('base64url');
    const db = new Database(`${DATA_DIR}/sessions.db`);
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, eb_session_id TEXT NOT NULL, account_uids TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(
      hashToken(expiredToken), 'expired', '[]', Date.now() - 7200_000, Date.now() - 3600_000,
    );
    db.close();

    // Expired token → 401
    const expiredRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${expiredToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        id: 1,
      }),
    });
    expect(expiredRes.status).toBe(401);

    // Revoke the real token
    const revokeRes = await fetch(`${BASE_URL}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: mcpAccessToken, client_id: clientId }).toString(),
    });
    expect(revokeRes.status).toBe(200);

    // Revoked token → 401
    const revokedRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${mcpAccessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        id: 1,
      }),
    });
    expect(revokedRes.status).toBe(401);
  });
});
