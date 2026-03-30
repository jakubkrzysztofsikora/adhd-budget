import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { EnableBankingClient } from '../enable-banking/client.js';

export interface ToolContext {
  getClient(): EnableBankingClient | null;
  getAccountUids(): string[];
  getSessionId(): string | null;
}

/**
 * Register all banking tools on the MCP server.
 * Tools are pure data access — no business logic.
 */
export function registerTools(server: McpServer, ctx?: ToolContext): void {
  server.tool(
    'accounts',
    'List all accounts at this bank with their IDs and types',
    {},
    async () => {
      const client = ctx?.getClient();
      const sessionId = ctx?.getSessionId();
      if (!client || !sessionId) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ accounts: [], note: 'Not authenticated with bank' }) }] };
      }

      try {
        const session = await client.getSession(sessionId);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ accounts: session.accounts }, null, 2) }] };
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
        const balances = await client.getBalances(account_id);
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
        const transactions = await client.getTransactions(account_id, date_from, date_to);
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
        // Get accounts to search across
        const accountIds = account_id ? [account_id] : (ctx?.getAccountUids() ?? []);
        const allResults: unknown[] = [];
        const lowerQuery = query.toLowerCase();

        for (const accId of accountIds) {
          const transactions = await client.getTransactions(accId);
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
