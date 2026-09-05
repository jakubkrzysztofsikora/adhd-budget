export interface BankDefinition {
  key: string;
  name: string;
  country: string;
  title: string;
}

export const SUPPORTED_BANKS: BankDefinition[] = [
  { key: 'pko_bp', name: 'PKO Bank Polski', country: 'PL', title: 'PKO Bank Polski (iPKO)' },
  { key: 'nest_bank', name: 'Nest Bank', country: 'PL', title: 'Nest Bank' },
  { key: 'revolut', name: 'Revolut', country: 'PL', title: 'Revolut' },
  { key: 'millennium', name: 'Bank Millennium', country: 'PL', title: 'Bank Millennium' },
  { key: 'mbank', name: 'mBank', country: 'PL', title: 'mBank' },
  { key: 'ing', name: 'ING Bank Śląski', country: 'PL', title: 'ING Bank Śląski' },
  { key: 'pekao', name: 'Bank Pekao', country: 'PL', title: 'Bank Pekao (PeoPay)' },
  { key: 'alior', name: 'Alior Bank', country: 'PL', title: 'Alior Bank' },
];

export interface Config {
  port: number;
  host: string;
  aspspName: string;
  aspspCountry: string;
  externalUrl: string;
  enableAppId: string;
  enablePrivateKeyPath: string;
  enableApiBaseUrl: string;
  dataDir: string;
  mcpToken: string;
  oauthUsers: Map<string, string>;
  defaultUser: string;
}

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Auto-load .env from current directory or parent directory when not in test mode
if (process.env.NODE_ENV !== 'test') {
  for (const envPath of ['.env', '../.env']) {
    if (existsSync(envPath)) {
      try {
        process.loadEnvFile(envPath);
        break;
      } catch {
        // Ignore if not loadable
      }
    }
  }
}

export function parseOAuthUsers(
  rawUsers?: string,
  defaultUser: string = 'jakub',
  defaultPassword?: string,
): Map<string, string> {
  const users = new Map<string, string>();
  if (rawUsers && rawUsers.trim()) {
    const pairs = rawUsers.split(/[,;]/);
    for (const pair of pairs) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const sepIdx = trimmed.indexOf(':') !== -1 ? trimmed.indexOf(':') : trimmed.indexOf('=');
      if (sepIdx !== -1) {
        const u = trimmed.slice(0, sepIdx).trim();
        const p = trimmed.slice(sepIdx + 1).trim();
        if (u && p) {
          users.set(u, p);
        }
      }
    }
  }

  if (users.size === 0) {
    const password = process.env.OAUTH_PASSWORD || defaultPassword || 'adhd_budget_secret_token_2026';
    users.set(defaultUser, password);
  }

  return users;
}

export function getConfig(): Config {
  let privateKeyPath = process.env.ENABLE_PRIVATE_KEY_PATH || '';
  if (privateKeyPath && !existsSync(privateKeyPath)) {
    const parentCandidate = resolve(process.cwd(), '..', privateKeyPath);
    if (existsSync(parentCandidate)) {
      privateKeyPath = parentCandidate;
    }
  }

  const defaultUser = process.env.OAUTH_DEFAULT_USER || 'jakub';
  const mcpToken = process.env.MCP_TOKEN || 'adhd_budget_secret_token_2026';
  const oauthUsers = parseOAuthUsers(process.env.OAUTH_USERS, defaultUser, process.env.OAUTH_PASSWORD || mcpToken);

  return {
    port: parseInt(process.env.PORT || '8081', 10),
    host: process.env.HOST || '0.0.0.0',
    aspspName: process.env.ASPSP_NAME || 'PKO Bank Polski',
    aspspCountry: process.env.ASPSP_COUNTRY || 'PL',
    externalUrl: process.env.EXTERNAL_URL || `http://localhost:${process.env.PORT || '8081'}`,
    enableAppId: process.env.ENABLE_APP_ID || '',
    enablePrivateKeyPath: privateKeyPath,
    enableApiBaseUrl: process.env.ENABLE_API_BASE_URL || 'https://api.enablebanking.com',
    dataDir: process.env.DATA_DIR || './data',
    mcpToken,
    oauthUsers,
    defaultUser,
  };
}

