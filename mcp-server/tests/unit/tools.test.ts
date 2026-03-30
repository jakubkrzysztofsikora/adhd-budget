import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/tools/index.js';

describe('MCP Tools', () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    server = new McpServer(
      { name: 'test-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    registerTools(server);

    client = new Client({ name: 'test-client', version: '1.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('lists all 5 registered tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('accounts');
    expect(names).toContain('balances');
    expect(names).toContain('transactions');
    expect(names).toContain('transaction');
    expect(names).toContain('search');
    expect(tools).toHaveLength(5);
  });

  it('accounts tool returns valid content', async () => {
    const result = await client.callTool({ name: 'accounts', arguments: {} });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toHaveProperty('type', 'text');
    const data = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(data).toHaveProperty('accounts');
  });

  it('balances tool requires account_id', async () => {
    const result = await client.callTool({ name: 'balances', arguments: { account_id: 'acc-123' } });
    const data = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(data.account_id).toBe('acc-123');
    expect(data).toHaveProperty('balances');
  });

  it('transactions tool accepts date range', async () => {
    const result = await client.callTool({
      name: 'transactions',
      arguments: { account_id: 'acc-123', date_from: '2026-01-01', date_to: '2026-01-31' },
    });
    const data = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(data.account_id).toBe('acc-123');
    expect(data).toHaveProperty('transactions');
  });

  it('transaction tool returns details for specific transaction', async () => {
    const result = await client.callTool({
      name: 'transaction',
      arguments: { account_id: 'acc-123', transaction_id: 'tx-456' },
    });
    const data = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(data.account_id).toBe('acc-123');
    expect(data.transaction_id).toBe('tx-456');
  });

  it('search tool accepts query and optional account_id', async () => {
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'groceries', account_id: 'acc-123' },
    });
    const data = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(data.query).toBe('groceries');
    expect(data).toHaveProperty('results');
  });

  it('each tool has inputSchema defined', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});
