import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';

const TEST_PORT = 9888;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = `./data/test-e2e-${randomUUID()}`;

function computeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function waitForHealthy(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch { /* wait */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server not healthy within ${timeoutMs}ms`);
}

describe('End-to-End OAuth 2.1 HTTP Flow', () => {
  let serverProcess: ChildProcess;
  const dummyKeyPath = `${TEST_DATA_DIR}/dummy.pem`;

  beforeAll(async () => {
    // Generate dummy PEM key to trigger OAuth provider initialization
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    writeFileSync(dummyKeyPath, privateKey);

    serverProcess = spawn('node', ['dist/index.js'], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        HOST: '127.0.0.1',
        DATA_DIR: TEST_DATA_DIR,
        ENABLE_APP_ID: 'test-app-id',
        ENABLE_PRIVATE_KEY_PATH: dummyKeyPath,
        EXTERNAL_URL: BASE_URL,
        MCP_TOKEN: 'secret_mcp_test',
        OAUTH_PASSWORD: 'jakub_e2e_password',
        LOG_LEVEL: 'silent',
        MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: '1',
      },
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    await waitForHealthy(BASE_URL);
  }, 15000);

  afterAll(async () => {
    serverProcess.kill('SIGTERM');
    await new Promise<void>(resolve => {
      serverProcess.on('exit', () => resolve());
      setTimeout(resolve, 2000);
    });
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
  });

  it('completes dynamic registration -> authorization -> token exchange -> /mcp', async () => {
    // 1. Dynamic Client Registration
    const regRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude E2E Test',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      }),
    });
    expect(regRes.status).toBe(201);
    const clientInfo = await regRes.json();
    expect(clientInfo.client_id).toBeTruthy();

    const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const codeChallenge = computeS256(codeVerifier);

    // 2. GET /authorize returns HTML login page
    const getAuthRes = await fetch(
      `${BASE_URL}/authorize?response_type=code&client_id=${clientInfo.client_id}&redirect_uri=https://claude.ai/api/mcp/auth_callback&code_challenge=${codeChallenge}&code_challenge_method=S256&state=claude-state-1`,
    );
    expect(getAuthRes.status).toBe(200);
    const getHtml = await getAuthRes.text();
    expect(getHtml).toContain('Authorize AI Assistant');
    expect(getHtml).toContain('Claude E2E Test');

    // 3. POST /authorize with wrong password
    const postFailRes = await fetch(`${BASE_URL}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientInfo.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: 'claude-state-1',
        username: 'jakub',
        password: 'wrong_password',
      }).toString(),
    });
    expect(postFailRes.status).toBe(200);
    const failHtml = await postFailRes.text();
    expect(failHtml).toContain('Invalid username or password');

    // 4. POST /authorize with correct password (302 redirect)
    const postSuccessRes = await fetch(`${BASE_URL}/authorize`, {
      method: 'POST',
      redirect: 'manual', // do not follow redirect to claude.ai
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientInfo.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: 'claude-state-1',
        username: 'jakub',
        password: 'jakub_e2e_password',
      }).toString(),
    });
    expect(postSuccessRes.status).toBe(302);
    const redirectLocation = postSuccessRes.headers.get('location')!;
    expect(redirectLocation).toContain('https://claude.ai/api/mcp/auth_callback?code=');
    expect(redirectLocation).toContain('&state=claude-state-1');

    const authCode = new URL(redirectLocation).searchParams.get('code')!;
    expect(authCode).toBeTruthy();

    // 5. POST /token exchanges code for access token
    const tokenRes = await fetch(`${BASE_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        code_verifier: codeVerifier,
        client_id: clientInfo.client_id,
        client_secret: clientInfo.client_secret || '',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      }).toString(),
    });

    const tokenText = await tokenRes.text();
    if (tokenRes.status !== 200) {
      console.error('Token endpoint error:', tokenRes.status, tokenText);
    }
    expect(tokenRes.status).toBe(200);
    const tokens = JSON.parse(tokenText);
    expect(tokens.access_token).toBeTruthy();

    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type).toBe('Bearer');

    // 6. Connect to /mcp with Bearer token
    const mcpRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'claude-ai', version: '1.0' },
        },
        id: 1,
      }),
    });
    expect(mcpRes.status).toBe(200);
    const sessionId = mcpRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
  });

  it('completes flow for public client (token_endpoint_auth_method: none) like Claude Web', async () => {
    // 1. Dynamic Client Registration as public client
    const regRes = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude Web Public Client',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(regRes.status).toBe(201);
    const clientInfo = await regRes.json();
    expect(clientInfo.client_id).toBeTruthy();
    expect(clientInfo.client_secret).toBeUndefined();

    const codeVerifier = 'E9Melhoa2OwvFrGMTJguCH5rtG6j30-fmr-6EBZnlGQ';
    const codeChallenge = computeS256(codeVerifier);

    // 2. POST /authorize with correct password
    const postRes = await fetch(`${BASE_URL}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientInfo.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: 'claude-web-state',
        username: 'jakub',
        password: 'jakub_e2e_password',
      }).toString(),
    });
    expect(postRes.status).toBe(302);
    const authCode = new URL(postRes.headers.get('location')!).searchParams.get('code')!;

    // 3. POST /token (no client_secret needed for public client)
    const tokenRes = await fetch(`${BASE_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        code_verifier: codeVerifier,
        client_id: clientInfo.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.access_token).toBeTruthy();

    // 4. Initialize MCP
    const mcpRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'claude-web', version: '1.0' },
        },
        id: 1,
      }),
    });
    expect(mcpRes.status).toBe(200);
  });
});

