import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { EnableBankingClient, EnableBankingTransaction, EnableBankingBalance } from '../enable-banking/client.js';
import type { SessionStore, BankConnection } from '../enable-banking/session-store.js';
import {
  cleanMerchantAndCategory,
  isInternalTransfer,
  analyzeSpending,
  detectSubscriptions,
  calculateCashflowForecast,
  type CleanTransaction,
} from '../analysis/polish-finance.js';

export interface ToolContext {
  getClient(): EnableBankingClient | null;
  getAccountUids(): string[];
  getSessionId(): string | null;
  getSessionStore?(): SessionStore | null;
}

// 5-minute in-memory cache to prevent PSD2 rate limits
const cache = {
  balances: new Map<string, { data: EnableBankingBalance[]; timestamp: number }>(),
  transactions: new Map<string, { data: EnableBankingTransaction[]; timestamp: number }>(),
};
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getCachedBalances(client: EnableBankingClient, accountId: string): Promise<EnableBankingBalance[]> {
  const cached = cache.balances.get(accountId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  const balances = await client.getBalances(accountId);
  cache.balances.set(accountId, { data: balances, timestamp: Date.now() });
  return balances;
}

async function getCachedTransactions(
  client: EnableBankingClient,
  accountId: string,
  dateFrom?: string,
  dateTo?: string,
): Promise<EnableBankingTransaction[]> {
  const cacheKey = `${accountId}:${dateFrom || ''}:${dateTo || ''}`;
  const cached = cache.transactions.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  const txs = await client.getTransactions(accountId, dateFrom, dateTo);
  cache.transactions.set(cacheKey, { data: txs, timestamp: Date.now() });
  return txs;
}

interface AccountTarget {
  bank: string;
  accountId: string;
  aspspName: string;
  ownerName: string;
}

function resolveAccountTargets(ctx?: ToolContext, bankFilter?: string, ownerFilter?: string): AccountTarget[] {
  const targets: AccountTarget[] = [];
  const sessionStore = ctx?.getSessionStore?.();

  if (sessionStore) {
    const connections = sessionStore.getAllBankConnections();
    for (const conn of connections) {
      if (bankFilter && conn.bank_key !== bankFilter && !conn.aspsp_name.toLowerCase().includes(bankFilter.toLowerCase())) {
        continue;
      }
      if (ownerFilter && !conn.owner_name.toLowerCase().includes(ownerFilter.toLowerCase())) {
        continue;
      }
      for (const accId of conn.account_uids) {
        targets.push({
          bank: conn.bank_key,
          accountId: accId,
          aspspName: conn.aspsp_name,
          ownerName: conn.owner_name,
        });
      }
    }
  }

  // Fallback to single session in context if no store or no connections found
  if (targets.length === 0 && ctx) {
    const uids = ctx.getAccountUids();
    for (const uid of uids) {
      targets.push({ bank: 'active_session', accountId: uid, aspspName: 'Connected Bank', ownerName: 'Jakub' });
    }
  }

  return targets;
}

function calculateDateRange(period: string): { dateFrom: string; dateTo: string; days: number } {
  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  let dateFrom = dateTo;
  let days = 1;

  if (period === 'yesterday') {
    const yest = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    dateFrom = yest.toISOString().slice(0, 10);
    days = 1;
  } else if (period === 'this_week') {
    const dayOfWeek = now.getDay() || 7; // 1 = Monday, 7 = Sunday
    const mon = new Date(now.getTime() - (dayOfWeek - 1) * 24 * 60 * 60 * 1000);
    dateFrom = mon.toISOString().slice(0, 10);
    days = dayOfWeek;
  } else if (period === 'this_month') {
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    dateFrom = firstDay.toISOString().slice(0, 10);
    days = now.getDate();
  } else if (period === 'last_30_days') {
    const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    dateFrom = past.toISOString().slice(0, 10);
    days = 30;
  }

  return { dateFrom, dateTo, days };
}

export function registerTools(server: McpServer, ctx?: ToolContext): void {
  // ==========================================
  // High-Value ADHD Tools (Pareto 80/20)
  // ==========================================

  server.tool(
    'get_financial_snapshot',
    'Get unified snapshot of all liquid balances and bank connections across all connected accounts and family members',
    {
      owner: z.string().optional().describe('Optional filter by account owner / person (e.g. Jakub, Karolina)'),
    },
    async ({ owner }) => {
      const client = ctx?.getClient();
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Enable Banking client not initialized' }) }], isError: true };
      }

      const targets = resolveAccountTargets(ctx, undefined, owner);
      const sessionStore = ctx?.getSessionStore?.();
      const connections = sessionStore?.getAllBankConnections(owner) || [];

      let totalPln = 0;
      let totalEur = 0;
      const accountsSummary: Array<Record<string, unknown>> = [];

      for (const target of targets) {
        try {
          const balances = await getCachedBalances(client, target.accountId);
          for (const b of balances) {
            const amt = parseFloat(b.balance_amount.amount);
            const curr = b.balance_amount.currency;
            if (curr === 'PLN') totalPln += amt;
            else if (curr === 'EUR') totalEur += amt;

            accountsSummary.push({
              owner: target.ownerName,
              bank: target.aspspName,
              account_id: target.accountId,
              balance_type: b.balance_type,
              amount: amt,
              currency: curr,
            });
          }
        } catch (err) {
          accountsSummary.push({
            owner: target.ownerName,
            bank: target.aspspName,
            account_id: target.accountId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Group totals by owner / person
      const byOwner: Record<string, { total_liquid_pln: number; total_liquid_eur: number; accounts_count: number }> = {};
      for (const acc of accountsSummary) {
        const o = (acc.owner as string) || 'Default';
        if (!byOwner[o]) byOwner[o] = { total_liquid_pln: 0, total_liquid_eur: 0, accounts_count: 0 };
        byOwner[o].accounts_count++;
        if (acc.currency === 'PLN' && typeof acc.amount === 'number') {
          byOwner[o].total_liquid_pln = Math.round((byOwner[o].total_liquid_pln + acc.amount) * 100) / 100;
        } else if (acc.currency === 'EUR' && typeof acc.amount === 'number') {
          byOwner[o].total_liquid_eur = Math.round((byOwner[o].total_liquid_eur + acc.amount) * 100) / 100;
        }
      }

      const result = {
        total_liquid_pln: Math.round(totalPln * 100) / 100,
        total_liquid_eur: Math.round(totalEur * 100) / 100,
        by_owner: Object.keys(byOwner).length > 1 || owner ? byOwner : undefined,
        connected_banks: connections.map(c => {
          const expiresAt = new Date(c.valid_until).getTime();
          const daysLeft = Math.round((expiresAt - Date.now()) / (24 * 3600 * 1000));
          return {
            id: c.id,
            bank: c.aspsp_name,
            key: c.bank_key,
            owner: c.owner_name,
            accounts_count: c.account_uids.length,
            consent_valid_until: c.valid_until,
            days_remaining: daysLeft,
            status: daysLeft > 0 ? 'active' : 'expired',
          };
        }),
        accounts: accountsSummary,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'get_spending_analysis',
    'Analyze spending velocity, top Polish merchants, outlier impulse buys, and internal transfer deduplication across all family members or by person',
    {
      period: z.enum(['today', 'yesterday', 'this_week', 'this_month', 'last_30_days']).default('this_month').describe('Time period for analysis'),
      bank: z.string().optional().describe('Optional bank filter (e.g. pko_bp, nest_bank, revolut)'),
      owner: z.string().optional().describe('Optional person/owner filter (e.g. Jakub, Karolina)'),
    },
    async ({ period, bank, owner }) => {
      const client = ctx?.getClient();
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Enable Banking client not initialized' }) }], isError: true };
      }

      const targets = resolveAccountTargets(ctx, bank, owner);
      const { dateFrom, dateTo, days } = calculateDateRange(period);

      const allCleanTxs: CleanTransaction[] = [];

      for (const target of targets) {
        try {
          const rawTxs = await getCachedTransactions(client, target.accountId, dateFrom, dateTo);
          for (const tx of rawTxs) {
            const rawAmount = parseFloat(tx.transaction_amount.amount);
            const desc = tx.remittance_information_unstructured || '';
            const cred = tx.creditor_name || '';
            const norm = cleanMerchantAndCategory(desc, cred);
            const isInternal = isInternalTransfer(desc, cred);

            allCleanTxs.push({
              id: tx.entry_reference || tx.transaction_id || `${target.accountId}-${desc.slice(0, 10)}`,
              bank: target.aspspName,
              account_id: target.accountId,
              owner: target.ownerName,
              date: tx.booking_date || tx.value_date || dateTo,
              amount: rawAmount,
              currency: tx.transaction_amount.currency,
              merchant: norm.merchant,
              category: norm.category,
              raw_description: desc,
              is_internal_transfer: isInternal,
              is_income: rawAmount > 0,
            });
          }
        } catch (err) {
          // Log or skip single account error
        }
      }

      const analysis = analyzeSpending(allCleanTxs, period, days);
      return { content: [{ type: 'text' as const, text: JSON.stringify(analysis, null, 2) }] };
    },
  );

  server.tool(
    'query_transactions',
    'Search and filter transactions across all connected banks and family members (PKO BP, Nest Bank, Revolut)',
    {
      query: z.string().optional().describe('Text search for merchant, title, or keyword'),
      bank: z.string().optional().describe('Filter by bank (e.g. pko_bp, nest_bank, revolut)'),
      owner: z.string().optional().describe('Optional person/owner filter (e.g. Jakub, Karolina)'),
      date_from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      date_to: z.string().optional().describe('End date (YYYY-MM-DD)'),
      limit: z.number().default(25).describe('Max results to return (default 25)'),
    },
    async ({ query, bank, owner, date_from, date_to, limit }) => {
      const client = ctx?.getClient();
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Enable Banking client not initialized' }) }], isError: true };
      }

      const targets = resolveAccountTargets(ctx, bank, owner);
      const results: CleanTransaction[] = [];
      const lowerQuery = query ? query.toLowerCase() : null;

      for (const target of targets) {
        try {
          const rawTxs = await getCachedTransactions(client, target.accountId, date_from, date_to);
          for (const tx of rawTxs) {
            const rawAmount = parseFloat(tx.transaction_amount.amount);
            const desc = tx.remittance_information_unstructured || '';
            const cred = tx.creditor_name || '';
            const norm = cleanMerchantAndCategory(desc, cred);

            if (lowerQuery) {
              const textToSearch = `${norm.merchant} ${norm.category} ${desc} ${cred}`.toLowerCase();
              if (!textToSearch.includes(lowerQuery)) continue;
            }

            results.push({
              id: tx.entry_reference || tx.transaction_id || `${target.accountId}-${desc.slice(0, 10)}`,
              bank: target.aspspName,
              account_id: target.accountId,
              owner: target.ownerName,
              date: tx.booking_date || tx.value_date || '',
              amount: rawAmount,
              currency: tx.transaction_amount.currency,
              merchant: norm.merchant,
              category: norm.category,
              raw_description: desc,
              is_internal_transfer: isInternalTransfer(desc, cred),
              is_income: rawAmount > 0,
            });

            if (results.length >= limit) break;
          }
        } catch (err) {
          // Skip account error
        }
        if (results.length >= limit) break;
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ count: results.length, transactions: results }, null, 2) }] };
    },
  );

  server.tool(
    'get_recurring_bills',
    'Detect recurring subscriptions, media, gym, rent, and utility bills across all accounts and members',
    {
      bank: z.string().optional().describe('Optional bank filter'),
      owner: z.string().optional().describe('Optional person/owner filter (e.g. Jakub, Karolina)'),
    },
    async ({ bank, owner }) => {
      const client = ctx?.getClient();
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Enable Banking client not initialized' }) }], isError: true };
      }

      const targets = resolveAccountTargets(ctx, bank, owner);
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const allTxs: CleanTransaction[] = [];

      for (const target of targets) {
        try {
          const rawTxs = await getCachedTransactions(client, target.accountId, sixtyDaysAgo);
          for (const tx of rawTxs) {
            const rawAmount = parseFloat(tx.transaction_amount.amount);
            const desc = tx.remittance_information_unstructured || '';
            const cred = tx.creditor_name || '';
            const norm = cleanMerchantAndCategory(desc, cred);

            allTxs.push({
              id: tx.entry_reference || tx.transaction_id || `${target.accountId}-${desc.slice(0, 10)}`,
              bank: target.aspspName,
              account_id: target.accountId,
              owner: target.ownerName,
              date: tx.booking_date || tx.value_date || '',
              amount: rawAmount,
              currency: tx.transaction_amount.currency,
              merchant: norm.merchant,
              category: norm.category,
              raw_description: desc,
              is_internal_transfer: isInternalTransfer(desc, cred),
              is_income: rawAmount > 0,
            });
          }
        } catch (err) {
          // Ignore
        }
      }

      const subs = detectSubscriptions(allTxs);
      const monthlyTotal = Math.round(subs.reduce((acc, s) => acc + s.monthly_amount, 0) * 100) / 100;

      return { content: [{ type: 'text' as const, text: JSON.stringify({ total_monthly_commitments_pln: monthlyTotal, count: subs.length, subscriptions: subs }, null, 2) }] };
    },
  );

  server.tool(
    'get_cashflow_forecast',
    'Calculate burn rate, safe daily spend allowance, and projected month-end balance',
    {
      owner: z.string().optional().describe('Optional filter by account owner (e.g., "Jakub", "Karolina")'),
    },
    async ({ owner }) => {
      const client = ctx?.getClient();
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Enable Banking client not initialized' }) }], isError: true };
      }

      const targets = resolveAccountTargets(ctx, undefined, owner);

      // 1. Get liquid balance
      let totalLiquidPln = 0;
      for (const target of targets) {
        try {
          const balances = await getCachedBalances(client, target.accountId);
          for (const b of balances) {
            if (b.balance_amount.currency === 'PLN') {
              totalLiquidPln += parseFloat(b.balance_amount.amount);
            }
          }
        } catch (err) {}
      }

      // 2. Get spent so far this month
      const now = new Date();
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      let spentSoFar = 0;
      const monthTxs: CleanTransaction[] = [];

      for (const target of targets) {
        try {
          const rawTxs = await getCachedTransactions(client, target.accountId, firstOfMonth);
          for (const tx of rawTxs) {
            const rawAmount = parseFloat(tx.transaction_amount.amount);
            const desc = tx.remittance_information_unstructured || '';
            const cred = tx.creditor_name || '';
            const isInternal = isInternalTransfer(desc, cred);

            if (!isInternal && rawAmount < 0) {
              spentSoFar += Math.abs(rawAmount);
            }

            monthTxs.push({
              id: tx.entry_reference || tx.transaction_id || '',
              bank: target.aspspName,
              account_id: target.accountId,
              owner: target.ownerName,
              date: tx.booking_date || '',
              amount: rawAmount,
              currency: tx.transaction_amount.currency,
              merchant: cleanMerchantAndCategory(desc, cred).merchant,
              category: cleanMerchantAndCategory(desc, cred).category,
              raw_description: desc,
              is_internal_transfer: isInternal,
              is_income: rawAmount > 0,
            });
          }
        } catch (err) {}
      }

      // 3. Detect subscriptions to factor upcoming bills
      const subs = detectSubscriptions(monthTxs);
      const forecast = calculateCashflowForecast(totalLiquidPln, spentSoFar, subs, now.getDate(), 30);

      return { content: [{ type: 'text' as const, text: JSON.stringify(forecast, null, 2) }] };
    },
  );

  // ==========================================
  // Low-Level Data Passthrough Tools (Legacy/Raw)
  // ==========================================

  server.tool(
    'accounts',
    'List all connected accounts with their IDs, types, bank names, and owners',
    {
      owner: z.string().optional().describe('Optional filter by account owner (e.g., "Jakub", "Karolina")'),
    },
    async ({ owner }) => {
      const client = ctx?.getClient();
      const sessionId = ctx?.getSessionId();
      const sessionStore = ctx?.getSessionStore?.();

      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ accounts: [], note: 'Not authenticated with bank' }) }] };
      }

      try {
        if (sessionStore) {
          const conns = sessionStore.getAllBankConnections(owner);
          const allAccounts = conns.flatMap(c =>
            c.accounts_data.length > 0
              ? c.accounts_data.map((acc: any) => ({ ...acc, bank: c.aspsp_name, owner: c.owner_name }))
              : c.account_uids.map(u => ({ uid: u, bank: c.aspsp_name, owner: c.owner_name }))
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify({ accounts: allAccounts }, null, 2) }] };
        }

        if (sessionId) {
          const session = await client.getSession(sessionId);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ accounts: session.accounts }, null, 2) }] };
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify({ accounts: [] }) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error fetching accounts: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'balances',
    'Get current balances for an account',
    { account_id: z.string().describe('The account ID to get balances for') },
    async ({ account_id }) => {
      const client = ctx?.getClient();
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ account_id, balances: [], note: 'Not authenticated' }) }] };
      }

      try {
        const balances = await getCachedBalances(client, account_id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ account_id, balances }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error fetching balances: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'transactions',
    'Query transactions for an account within a date range',
    {
      account_id: z.string().describe('The account ID'),
      date_from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      date_to: z.string().optional().describe('End date (YYYY-MM-DD)'),
    },
    async ({ account_id, date_from, date_to }) => {
      const client = ctx?.getClient();
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ account_id, transactions: [], note: 'Not authenticated' }) }] };
      }

      try {
        const transactions = await getCachedTransactions(client, account_id, date_from, date_to);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ account_id, date_from, date_to, count: transactions.length, transactions }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error fetching transactions: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'transaction',
    'Get details of a specific transaction',
    {
      account_id: z.string().describe('The account ID'),
      transaction_id: z.string().describe('The transaction ID'),
    },
    async ({ account_id, transaction_id }) => {
      const client = ctx?.getClient();
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ account_id, transaction_id, details: null, note: 'Not authenticated' }) }] };
      }

      try {
        const details = await client.getTransactionDetails(account_id, transaction_id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ account_id, transaction_id, details }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error fetching transaction: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'search',
    'Free-text search over recent transactions',
    {
      query: z.string().describe('Search query'),
      account_id: z.string().optional().describe('Optional: limit to specific account'),
    },
    async ({ query, account_id }) => {
      const client = ctx?.getClient();
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ query, results: [], note: 'Not authenticated' }) }] };
      }

      try {
        const accountIds = account_id ? [account_id] : (ctx?.getAccountUids() ?? []);
        const allResults: unknown[] = [];
        const lowerQuery = query.toLowerCase();

        for (const accId of accountIds) {
          const transactions = await getCachedTransactions(client, accId);
          const matches = transactions.filter(tx => {
            const searchable = [
              tx.remittance_information_unstructured,
              tx.creditor_name,
              tx.debtor_name,
              tx.transaction_amount?.amount,
            ].filter(Boolean).join(' ').toLowerCase();
            return searchable.includes(lowerQuery);
          });
          allResults.push(...matches.map(tx => ({ ...tx, account_id: accId })));
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify({ query, account_id, count: allResults.length, results: allResults }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error searching transactions: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
