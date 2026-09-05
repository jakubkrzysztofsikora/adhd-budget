import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

// Allowed redirect URIs (Claude, ChatGPT, Odysseus, local tooling)
const ALLOWED_REDIRECT_PATTERNS = [
  /^https:\/\/(www\.)?claude\.ai\/api\/mcp\/auth_callback$/,
  /^https:\/\/(www\.)?claude\.com\/api\/mcp\/auth_callback$/,
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/,
  /^http:\/\/localhost:\d+$/, // MCP Inspector
  /^https:\/\/.*odysseus.*$/,
  /^https:\/\/.*bieda\.it.*$/,
  /^https:\/\/(www\.)?chatgpt\.com\/.*$/,
  /^https:\/\/.*openai\.com\/.*$/,
];


function isAllowedRedirectUri(uri: string): boolean {
  if (process.env.ALLOW_ALL_REDIRECTS === 'true') return true;
  return ALLOWED_REDIRECT_PATTERNS.some(p => p.test(uri));
}

export class ClientRegistry implements OAuthRegisteredClientsStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        client_data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare('SELECT client_data FROM clients WHERE client_id = ?').get(clientId) as
      | { client_data: string }
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.client_data);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    // Validate redirect URIs against allowlist
    if (client.redirect_uris) {
      for (const uri of client.redirect_uris) {
        if (!isAllowedRedirectUri(uri)) {
          throw new InvalidClientMetadataError(`Redirect URI not allowed: ${uri}`);
        }
      }
    }

    const clientId = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const fullClient: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: now,
    };

    this.db.prepare('INSERT INTO clients (client_id, client_data, created_at) VALUES (?, ?, ?)').run(
      clientId,
      JSON.stringify(fullClient),
      Date.now(),
    );

    return fullClient;
  }

  close(): void {
    this.db.close();
  }
}
