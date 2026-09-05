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

export interface BankConnection {
  bank_key: string;
  aspsp_name: string;
  aspsp_country: string;
  session_id: string;
  account_uids: string[];
  accounts_data: Array<{ uid: string; [key: string]: unknown }>;
  valid_until: string;
  created_at: number;
  updated_at: number;
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
      );
      CREATE TABLE IF NOT EXISTS bank_connections (
        bank_key TEXT PRIMARY KEY,
        aspsp_name TEXT NOT NULL,
        aspsp_country TEXT NOT NULL,
        session_id TEXT NOT NULL,
        account_uids TEXT NOT NULL,
        accounts_data TEXT NOT NULL DEFAULT '[]',
        valid_until TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  saveBankConnection(conn: {
    bank_key: string;
    aspsp_name: string;
    aspsp_country: string;
    session_id: string;
    account_uids: string[];
    accounts_data?: unknown[];
    valid_until: string;
  }): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO bank_connections (bank_key, aspsp_name, aspsp_country, session_id, account_uids, accounts_data, valid_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bank_key) DO UPDATE SET
        aspsp_name = excluded.aspsp_name,
        aspsp_country = excluded.aspsp_country,
        session_id = excluded.session_id,
        account_uids = excluded.account_uids,
        accounts_data = excluded.accounts_data,
        valid_until = excluded.valid_until,
        updated_at = excluded.updated_at
    `).run(
      conn.bank_key,
      conn.aspsp_name,
      conn.aspsp_country,
      conn.session_id,
      JSON.stringify(conn.account_uids),
      JSON.stringify(conn.accounts_data || []),
      conn.valid_until,
      now,
      now,
    );
  }

  getBankConnection(bankKey: string): BankConnection | null {
    const row = this.db.prepare('SELECT * FROM bank_connections WHERE bank_key = ?').get(bankKey) as
      | {
          bank_key: string;
          aspsp_name: string;
          aspsp_country: string;
          session_id: string;
          account_uids: string;
          accounts_data: string;
          valid_until: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      ...row,
      account_uids: JSON.parse(row.account_uids),
      accounts_data: JSON.parse(row.accounts_data || '[]'),
    };
  }

  getAllBankConnections(): BankConnection[] {
    const rows = this.db.prepare('SELECT * FROM bank_connections ORDER BY aspsp_name ASC').all() as Array<{
      bank_key: string;
      aspsp_name: string;
      aspsp_country: string;
      session_id: string;
      account_uids: string;
      accounts_data: string;
      valid_until: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map(r => ({
      ...r,
      account_uids: JSON.parse(r.account_uids),
      accounts_data: JSON.parse(r.accounts_data || '[]'),
    }));
  }

  deleteBankConnection(bankKey: string): void {
    this.db.prepare('DELETE FROM bank_connections WHERE bank_key = ?').run(bankKey);
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
