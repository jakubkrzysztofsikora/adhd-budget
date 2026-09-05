import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, existsSync } from 'node:fs';
import { getConfig } from './config.js';
import { registerTools, type ToolContext } from './tools/index.js';
import { EnableBankingClient } from './enable-banking/client.js';
import { SessionStore } from './enable-banking/session-store.js';

const config = getConfig();
const sessionStore = new SessionStore(`${config.dataDir}/sessions.db`);

let ebClient: EnableBankingClient | null = null;
if (config.enableAppId && config.enablePrivateKeyPath && existsSync(config.enablePrivateKeyPath)) {
  try {
    const privateKey = readFileSync(config.enablePrivateKeyPath, 'utf-8');
    ebClient = new EnableBankingClient(config.enableAppId, privateKey, config.enableApiBaseUrl);
  } catch (err) {
    console.error('Failed to initialize Enable Banking client:', err);
  }
}

const server = new McpServer(
  { name: 'adhd-budget', version: '2.1.0' },
  { capabilities: { tools: {} } },
);

const ctx: ToolContext = {
  getClient: () => ebClient,
  getAccountUids: () => [],
  getSessionId: () => null,
  getSessionStore: () => sessionStore,
};

registerTools(server, ctx);

const transport = new StdioServerTransport();
await server.connect(transport);
