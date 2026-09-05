import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';

const TEST_PORT = 9880;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_TOKEN = 'test_secret_bearer_token_123';

async function waitForHealthy(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} not healthy within ${timeoutMs}ms`);
}

describe('Bearer Auth and Connect Dashboard', () => {
  let serverProcess: ChildProcess;

  beforeAll(async () => {
    serverProcess = spawn('node', ['dist/index.js'], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        HOST: '127.0.0.1',
        MCP_TOKEN: TEST_TOKEN,
        LOG_LEVEL: 'silent',
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
  });

  it('connect dashboard responds with HTML', async () => {
    const res = await fetch(`${BASE_URL}/connect`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ADHD Budget — Polish Bank Hub');
    expect(html).toContain('PKO Bank Polski');
    expect(html).toContain('Nest Bank');
    expect(html).toContain('Revolut');
  });

  it('MCP initialize succeeds with Bearer token header', async () => {
    const initRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'claude-code-test', version: '1.0.0' },
        },
        id: 1,
      }),
    });

    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
  });
});
