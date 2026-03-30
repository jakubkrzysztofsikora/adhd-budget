import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';

const TEST_PORT = 9877;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function waitForHealthy(url: string, timeoutMs = 10000): Promise<void> {
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

describe('OAuth Flow (no EB credentials)', () => {
  let serverProcess: ChildProcess;

  beforeAll(async () => {
    serverProcess = spawn('node', ['dist/index.js'], {
      env: { ...process.env, PORT: String(TEST_PORT), HOST: '127.0.0.1', LOG_LEVEL: 'silent' },
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
  });

  it('health reports auth as none when no EB credentials', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json();
    expect(body.auth).toBe('none');
  });

  it('MCP endpoint works without auth when no EB credentials', async () => {
    // Initialize
    const initRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
        id: 1,
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    // Send initialized notification
    await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    // List tools
    const toolsRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
    });
    expect(toolsRes.status).toBe(200);
  });
});

describe('OAuth Metadata Discovery', () => {
  // This test doesn't need EB credentials — the server runs without auth
  // so well-known endpoints won't exist. We just verify the server behavior.

  let serverProcess: ChildProcess;

  beforeAll(async () => {
    serverProcess = spawn('node', ['dist/index.js'], {
      env: { ...process.env, PORT: String(TEST_PORT + 1), HOST: '127.0.0.1', LOG_LEVEL: 'silent' },
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    await waitForHealthy(`http://localhost:${TEST_PORT + 1}`);
  }, 15000);

  afterAll(async () => {
    serverProcess.kill('SIGTERM');
    await new Promise<void>(resolve => {
      serverProcess.on('exit', () => resolve());
      setTimeout(resolve, 2000);
    });
  });

  it('well-known endpoints return 404 when no OAuth configured', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT + 1}/.well-known/oauth-authorization-server`);
    // When no OAuth provider, these endpoints don't exist
    expect(res.status).toBe(404);
  });
});
