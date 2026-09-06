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
  parseEnableBankingTransaction,
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

async function getCachedBalances(
  client: EnableBankingClient,
  accountId: string,
  sessionStore?: SessionStore | null,
): Promise<EnableBankingBalance[]> {
  const cached = cache.balances.get(accountId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const balances = await client.getBalances(accountId);
    cache.balances.set(accountId, { data: balances, timestamp: Date.now() });
    if (sessionStore) {
      sessionStore.saveAccountBalances(accountId, balances);
    }
    return balances;
  } catch (err) {
    if (sessionStore) {
      const persisted = sessionStore.getAccountBalances(accountId) as EnableBankingBalance[];
      if (persisted && persisted.length > 0) {
        return persisted;
      }
    }
    throw err;
  }
}

async function getCachedTransactions(
  client: EnableBankingClient,
  accountId: string,
  dateFrom?: string,
  dateTo?: string,
  sessionStore?: SessionStore | null,
): Promise<EnableBankingTransaction[]> {
  const cacheKey = `${accountId}:${dateFrom || ''}:${dateTo || ''}`;
  const cached = cache.transactions.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const txs = await client.getTransactions(accountId, dateFrom, dateTo);
    cache.transactions.set(cacheKey, { data: txs, timestamp: Date.now() });
    if (sessionStore) {
      sessionStore.saveAccountTransactions(accountId, txs);
    }
    return txs;
  } catch (err) {
    if (sessionStore) {
      const persisted = sessionStore.getAccountTransactions(accountId) as EnableBankingTransaction[];
      if (persisted && persisted.length > 0) {
        return persisted;
      }
    }
    throw err;
  }
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
  const sessionStore = ctx?.getSessionStore?.();

  // ==========================================
  // High-Value ADHD Tools (Pareto 80/20)
  // ==========================================

  server.tool(
    'get_financial_snapshot',
    'Get unified snapshot of all liquid balances, credit lines, and bank connections across all connected accounts and family members',
    {
      owner: z.string().optional().describe('Optional filter by account owner / person (e.g. Jakub, Arleta)'),
    },
    async ({ owner }) => {
      const client = ctx?.getClient();
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Enable Banking client not initialized' }) }], isError: true };
      }

      const targets = resolveAccountTargets(ctx, undefined, owner);
      const sessionStore = ctx?.getSessionStore?.();
      const connections = sessionStore?.getAllBankConnections(owner) || [];

      let totalLiquidPln = 0;
      let totalCreditDebtPln = 0;
      const foreignTotals: Record<string, number> = {};
      const accountsSummary: Array<Record<string, unknown>> = [];

      for (const target of targets) {
        try {
          const balances = await getCachedBalances(client, target.accountId, sessionStore);
          
          // Deduplicate: pick the single primary balance for this account
          // Priority: ITAV (Interim Available) > CLBD (Closing Booked) > ITBD (Interim Booked) > first
          const primary = balances.find(b => b.balance_type === 'ITAV')
            || balances.find(b => b.balance_type === 'CLBD')
            || balances.find(b => b.balance_type === 'ITBD')
            || balances[0];

          if (primary) {
            const amt = parseFloat(primary.balance_amount.amount);
            const curr = primary.balance_amount.currency;

            if (curr === 'PLN') {
              if (amt >= 0) totalLiquidPln += amt;
              else totalCreditDebtPln += Math.abs(amt);
            } else {
              foreignTotals[curr] = (foreignTotals[curr] || 0) + amt;
            }

            accountsSummary.push({
              owner: target.ownerName,
              bank: target.aspspName,
              account_id: target.accountId,
              balance_type: primary.balance_type,
              amount: amt,
              currency: curr,
              is_credit_debt: amt < 0,
              all_balances: balances.map(b => ({
                type: b.balance_type,
                amount: parseFloat(b.balance_amount.amount),
                currency: b.balance_amount.currency,
              })),
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
      const byOwner: Record<string, {
        total_liquid_pln: number;
        total_liquid_eur: number;
        liquid_pln: number;
        credit_debt_pln: number;
        net_pln: number;
        accounts_count: number;
      }> = {};
      for (const acc of accountsSummary) {
        const o = (acc.owner as string) || 'Default';
        if (!byOwner[o]) {
          byOwner[o] = {
            total_liquid_pln: 0,
            total_liquid_eur: 0,
            liquid_pln: 0,
            credit_debt_pln: 0,
            net_pln: 0,
            accounts_count: 0,
          };
        }
        byOwner[o].accounts_count++;
        if (typeof acc.amount === 'number') {
          if (acc.currency === 'PLN') {
            if (acc.amount >= 0) {
              byOwner[o].liquid_pln = Math.round((byOwner[o].liquid_pln + acc.amount) * 100) / 100;
              byOwner[o].total_liquid_pln = byOwner[o].liquid_pln;
            } else {
              byOwner[o].credit_debt_pln = Math.round((byOwner[o].credit_debt_pln + Math.abs(acc.amount)) * 100) / 100;
            }
            byOwner[o].net_pln = Math.round((byOwner[o].liquid_pln - byOwner[o].credit_debt_pln) * 100) / 100;
          } else if (acc.currency === 'EUR' && acc.amount >= 0) {
            byOwner[o].total_liquid_eur = Math.round((byOwner[o].total_liquid_eur + acc.amount) * 100) / 100;
          }
        }
      }

      const totalEur = foreignTotals['EUR'] || 0;

      // Manual & Offline Assets (Vaults, Crypto, Investments, Physical Vault)
      const manualAccounts = sessionStore?.getAllManualAccounts(owner) || [];
      const savingsVaultsPln = manualAccounts
        .filter(m => m.type === 'savings_vault' && m.currency === 'PLN')
        .reduce((sum, m) => sum + m.balance, 0);
      const savingsVaultsEur = manualAccounts
        .filter(m => m.type === 'savings_vault' && m.currency === 'EUR')
        .reduce((sum, m) => sum + m.balance, 0);
      const investmentsPln = manualAccounts
        .filter(m => m.type === 'investments' && m.currency === 'PLN')
        .reduce((sum, m) => sum + m.balance, 0);
      const physicalVaultPln = manualAccounts
        .filter(m => m.type === 'physical_vault' && m.currency === 'PLN')
        .reduce((sum, m) => sum + m.balance, 0);
      const cryptoAssets = manualAccounts
        .filter(m => m.type === 'crypto')
        .map(m => ({ currency: m.currency, amount: m.balance, name: m.name }));

      const totalOfflineAssetsPln = savingsVaultsPln + investmentsPln + physicalVaultPln;

      const result = {
        total_liquid_pln: Math.round(totalLiquidPln * 100) / 100,
        total_liquid_eur: Math.round(totalEur * 100) / 100,
        total_credit_debt_pln: Math.round(totalCreditDebtPln * 100) / 100,
        net_liquid_pln: Math.round((totalLiquidPln - totalCreditDebtPln) * 100) / 100,
        net_pln: Math.round((totalLiquidPln - totalCreditDebtPln) * 100) / 100,
        manual_offline_assets: {
          savings_vaults_pln: Math.round(savingsVaultsPln * 100) / 100,
          savings_vaults_eur: Math.round(savingsVaultsEur * 100) / 100,
          investments_pln: Math.round(investmentsPln * 100) / 100,
          physical_vault_pln: Math.round(physicalVaultPln * 100) / 100,
          crypto_assets: cryptoAssets,
          accounts: manualAccounts,
        },
        total_savings_buffer_pln: Math.round((totalLiquidPln + savingsVaultsPln) * 100) / 100,
        estimated_total_net_worth_pln: Math.round((totalLiquidPln + totalOfflineAssetsPln - totalCreditDebtPln) * 100) / 100,
        foreign_currencies: Object.entries(foreignTotals).map(([curr, amt]) => ({
          currency: curr,
          amount: Math.round(amt * 100) / 100,
        })),
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
          const rawTxs = await getCachedTransactions(client, target.accountId, dateFrom, dateTo, sessionStore);
          for (const tx of rawTxs) {
            allCleanTxs.push(parseEnableBankingTransaction(tx, target.aspspName, target.accountId, target.ownerName, dateTo));
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
          const rawTxs = await getCachedTransactions(client, target.accountId, date_from, date_to, sessionStore);
          for (const tx of rawTxs) {
            const clean = parseEnableBankingTransaction(tx, target.aspspName, target.accountId, target.ownerName, date_to || '');

            if (lowerQuery) {
              const textToSearch = `${clean.merchant} ${clean.category} ${clean.raw_description}`.toLowerCase();
              if (!textToSearch.includes(lowerQuery)) continue;
            }

            results.push(clean);
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
          const rawTxs = await getCachedTransactions(client, target.accountId, sixtyDaysAgo, undefined, sessionStore);
          for (const tx of rawTxs) {
            allTxs.push(parseEnableBankingTransaction(tx, target.aspspName, target.accountId, target.ownerName, sixtyDaysAgo));
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

      // 1. Get liquid balance (deduplicated primary positive balances)
      let totalLiquidPln = 0;
      for (const target of targets) {
        try {
          const balances = await getCachedBalances(client, target.accountId, sessionStore);
          const primary = balances.find(b => b.balance_type === 'ITAV')
            || balances.find(b => b.balance_type === 'CLBD')
            || balances.find(b => b.balance_type === 'ITBD')
            || balances[0];

          if (primary && primary.balance_amount.currency === 'PLN') {
            const amt = parseFloat(primary.balance_amount.amount);
            if (amt > 0) totalLiquidPln += amt;
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
          const rawTxs = await getCachedTransactions(client, target.accountId, firstOfMonth, undefined, sessionStore);
          for (const tx of rawTxs) {
            const clean = parseEnableBankingTransaction(tx, target.aspspName, target.accountId, target.ownerName, firstOfMonth);
            if (!clean.is_internal_transfer && clean.amount < 0) {
              spentSoFar += Math.abs(clean.amount);
            }
            monthTxs.push(clean);
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
          const manualAccs = sessionStore.getAllManualAccounts(owner);

          const allAccounts = [
            ...conns.flatMap(c =>
              c.accounts_data.length > 0
                ? c.accounts_data.map((acc: any) => ({ ...acc, bank: c.aspsp_name, owner: c.owner_name, synced: true }))
                : c.account_uids.map(u => ({ uid: u, bank: c.aspsp_name, owner: c.owner_name, synced: true }))
            ),
            ...manualAccs.map(m => ({
              uid: m.id,
              bank: m.institution || m.name,
              owner: m.owner_name,
              name: m.name,
              type: m.type,
              balance: m.balance,
              currency: m.currency,
              notes: m.notes,
              synced: false,
              is_manual: true,
            })),
          ];
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
