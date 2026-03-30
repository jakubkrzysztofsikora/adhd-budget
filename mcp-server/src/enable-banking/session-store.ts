import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SessionRecord {
  token_hash: string;
  eb_session_id: string;
  account_uids: string[];
  created_at: number;
  expires_at: number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SessionStore {
  private db: Database.Database;

  constructor(dbPath: string = './data/sessions.db') {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        eb_session_id TEXT NOT NULL,
        account_uids TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  store(mcpToken: string, ebSessionId: string, accountUids: string[], expiresAt: number): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO sessions (token_hash, eb_session_id, account_uids, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(hashToken(mcpToken), ebSessionId, JSON.stringify(accountUids), Date.now(), expiresAt);
  }

  getByToken(mcpToken: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(mcpToken)) as
      | (Omit<SessionRecord, 'account_uids'> & { account_uids: string })
      | undefined;
    if (!row) return null;
    if (Date.now() > row.expires_at) {
      this.revokeByHash(row.token_hash);
      return null;
    }
    return { ...row, account_uids: JSON.parse(row.account_uids) };
  }

  revoke(mcpToken: string): void {
    this.revokeByHash(hashToken(mcpToken));
  }

  private revokeByHash(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  cleanup(): number {
    const result = this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
