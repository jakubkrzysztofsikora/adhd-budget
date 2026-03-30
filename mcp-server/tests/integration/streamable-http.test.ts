import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TEST_PORT = 9876;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function waitForHealthy(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not become healthy within ${timeoutMs}ms`);
}

describe('Streamable HTTP Transport', () => {
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

  it('health endpoint returns ok', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('initialize and list tools via SDK client', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`));
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.length).toBe(5);
    expect(tools.map(t => t.name)).toContain('accounts');

    await client.close();
  });

  it('tool invocation works via HTTP', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`));
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    await client.connect(transport);

    const result = await client.callTool({ name: 'accounts', arguments: {} });
    expect(result.content).toHaveLength(1);
    const data = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(data).toHaveProperty('accounts');

    await client.close();
  });

  it('POST /mcp without session ID and non-initialize body returns 400', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it('initialize returns Mcp-Session-Id header', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
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
    expect(res.status).toBe(200);
    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
  });

  it('DELETE /mcp with invalid session returns 400', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': 'nonexistent-session' },
    });
    expect(res.status).toBe(400);
  });

  it('multiple sessions are independent', async () => {
    const transport1 = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`));
    const transport2 = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`));
    const client1 = new Client({ name: 'client-1', version: '1.0.0' });
    const client2 = new Client({ name: 'client-2', version: '1.0.0' });

    await client1.connect(transport1);
    await client2.connect(transport2);

    const [tools1, tools2] = await Promise.all([client1.listTools(), client2.listTools()]);
    expect(tools1.tools.length).toBe(5);
    expect(tools2.tools.length).toBe(5);

    await client1.close();
    await client2.close();
  });
});
