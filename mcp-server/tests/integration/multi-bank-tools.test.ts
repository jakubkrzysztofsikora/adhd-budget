import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, type ToolContext } from '../../src/tools/index.js';
import { SessionStore } from '../../src/enable-banking/session-store.js';
import type { EnableBankingClient, EnableBankingBalance, EnableBankingTransaction } from '../../src/enable-banking/client.js';
import { unlinkSync } from 'node:fs';

const TEST_DB = './data/test-multibank.db';

describe('Multi-Bank MCP Financial Tools', () => {
  let client: Client;
  let server: McpServer;
  let sessionStore: SessionStore;

  const mockBalances: Record<string, EnableBankingBalance[]> = {
    'pko-acc-1': [{ balance_amount: { amount: '4500.50', currency: 'PLN' }, balance_type: 'CLBD' }],
    'nest-acc-1': [{ balance_amount: { amount: '12000.00', currency: 'PLN' }, balance_type: 'CLBD' }],
    'rev-acc-1': [{ balance_amount: { amount: '850.00', currency: 'PLN' }, balance_type: 'CLBD' }],
    'rev-acc-2': [{ balance_amount: { amount: '200.00', currency: 'EUR' }, balance_type: 'CLBD' }],
  };

  const mockTransactions: Record<string, EnableBankingTransaction[]> = {
    'pko-acc-1': [
      {
        transaction_id: 'tx-1',
        transaction_amount: { amount: '-120.50', currency: 'PLN' },
        booking_date: '2026-09-02',
        remittance_information_unstructured: 'PŁATNOŚĆ KARTĄ BIEDRONKA 4821',
      },
      {
        transaction_id: 'tx-2',
        transaction_amount: { amount: '-500.00', currency: 'PLN' },
        booking_date: '2026-09-03',
        remittance_information_unstructured: 'PRZELEW WŁASNY ZASILENIE REVOLUT',
      },
      {
        transaction_id: 'tx-3',
        transaction_amount: { amount: '-45.00', currency: 'PLN' },
        booking_date: '2026-09-01',
        remittance_information_unstructured: 'NETFLIX.COM AMSTERDAM',
      },
    ],
    'rev-acc-1': [
      {
        transaction_id: 'tx-4',
        transaction_amount: { amount: '500.00', currency: 'PLN' },
        booking_date: '2026-09-03',
        remittance_information_unstructured: 'Top-up from PKO',
      },
      {
        transaction_id: 'tx-5',
        transaction_amount: { amount: '-25.00', currency: 'PLN' },
        booking_date: '2026-09-04',
        remittance_information_unstructured: 'ŻABKA Z123 KRAKÓW',
      },
    ],
  };

  const mockEbClient: Partial<EnableBankingClient> = {
    getBalances: async (accountId: string) => mockBalances[accountId] || [],
    getTransactions: async (accountId: string) => mockTransactions[accountId] || [],
  };

  beforeEach(async () => {
    sessionStore = new SessionStore(TEST_DB);

    // Seed PKO, Nest, and Revolut
    sessionStore.saveBankConnection({
      bank_key: 'pko_bp',
      aspsp_name: 'PKO Bank Polski',
      aspsp_country: 'PL',
      session_id: 'pko-session-1',
      account_uids: ['pko-acc-1'],
      valid_until: '2026-12-01T00:00:00Z',
    });
    sessionStore.saveBankConnection({
      bank_key: 'nest_bank',
      aspsp_name: 'Nest Bank',
      aspsp_country: 'PL',
      session_id: 'nest-session-1',
      account_uids: ['nest-acc-1'],
      valid_until: '2026-12-01T00:00:00Z',
    });
    sessionStore.saveBankConnection({
      bank_key: 'revolut',
      aspsp_name: 'Revolut',
      aspsp_country: 'PL',
      session_id: 'rev-session-1',
      account_uids: ['rev-acc-1', 'rev-acc-2'],
      valid_until: '2026-12-01T00:00:00Z',
    });

    const ctx: ToolContext = {
      getClient: () => mockEbClient as EnableBankingClient,
      getAccountUids: () => ['pko-acc-1', 'nest-acc-1', 'rev-acc-1', 'rev-acc-2'],
      getSessionId: () => 'pko-session-1',
      getSessionStore: () => sessionStore,
    };

    server = new McpServer({ name: 'adhd-gateway', version: '2.1.0' }, { capabilities: { tools: {} } });
    registerTools(server, ctx);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    sessionStore.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('get_financial_snapshot aggregates balances across all 3 banks', async () => {
    const res = await client.callTool({ name: 'get_financial_snapshot', arguments: {} });
    expect(res.content).toHaveLength(1);
    const data = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);

    // 4500.50 (PKO) + 12000 (Nest) + 850 (Revolut) = 17350.50 PLN
    expect(data.total_liquid_pln).toBe(17350.5);
    // 200 EUR on Revolut
    expect(data.total_liquid_eur).toBe(200.0);
    expect(data.connected_banks.length).toBe(3);
    expect(data.connected_banks.map((b: any) => b.bank)).toContain('PKO Bank Polski');
    expect(data.connected_banks.map((b: any) => b.bank)).toContain('Nest Bank');
    expect(data.connected_banks.map((b: any) => b.bank)).toContain('Revolut');
  });

  it('get_spending_analysis deduplicates internal transfer between PKO and Revolut', async () => {
    const res = await client.callTool({ name: 'get_spending_analysis', arguments: { period: 'this_month' } });
    const data = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);

    // 120.50 (Biedronka) + 45 (Netflix) + 25 (Żabka) = 190.50 PLN (500 PLN transfer excluded!)
    expect(data.total_spent_pln).toBe(190.5);
    expect(data.internal_transfers_excluded.length).toBeGreaterThanOrEqual(1);
    expect(data.top_merchants.map((m: any) => m.merchant)).toContain('Biedronka');
    expect(data.top_merchants.map((m: any) => m.merchant)).toContain('Żabka');
  });

  it('query_transactions searches across banks', async () => {
    const res = await client.callTool({ name: 'query_transactions', arguments: { query: 'biedronka' } });
    const data = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
    expect(data.count).toBe(1);
    expect(data.transactions[0].merchant).toBe('Biedronka');
    expect(data.transactions[0].bank).toBe('PKO Bank Polski');
  });

  it('get_recurring_bills detects Netflix subscription', async () => {
    const res = await client.callTool({ name: 'get_recurring_bills', arguments: {} });
    const data = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
    expect(data.subscriptions.map((s: any) => s.merchant)).toContain('Netflix');
  });

  it('get_cashflow_forecast calculates safe daily spend', async () => {
    const res = await client.callTool({ name: 'get_cashflow_forecast', arguments: {} });
    const data = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
    expect(data.current_liquid_balance_pln).toBe(17350.5);
    expect(data.safe_daily_spend_limit_pln).toBeGreaterThan(0);
    expect(data.status).toBe('on_track');
  });
});
