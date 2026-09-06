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
  id: string;
  bank_key: string;
  aspsp_name: string;
  aspsp_country: string;
  session_id: string;
  account_uids: string[];
  accounts_data: Array<{ uid: string; [key: string]: unknown }>;
  owner_name: string;
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
    `);

    // Schema migration: ensure bank_connections supports multiple people per bank (id as PK, owner_name column)
    const tableInfo = this.db.prepare("PRAGMA table_info(bank_connections)").all() as Array<{ name: string; pk: number }>;
    if (tableInfo.length > 0) {
      const hasIdPk = tableInfo.some(col => col.name === 'id' && col.pk === 1);
      if (!hasIdPk) {
        // Old schema detected (bank_key was PK). Migrate to new schema with id PK and owner_name.
        this.db.exec(`
          ALTER TABLE bank_connections RENAME TO _bank_connections_old;
          CREATE TABLE bank_connections (
            id TEXT PRIMARY KEY,
            bank_key TEXT NOT NULL,
            aspsp_name TEXT NOT NULL,
            aspsp_country TEXT NOT NULL,
            session_id TEXT NOT NULL,
            account_uids TEXT NOT NULL,
            accounts_data TEXT NOT NULL DEFAULT '[]',
            owner_name TEXT NOT NULL DEFAULT 'Jakub',
            valid_until TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          INSERT INTO bank_connections (id, bank_key, aspsp_name, aspsp_country, session_id, account_uids, accounts_data, owner_name, valid_until, created_at, updated_at)
          SELECT 
            bank_key || '_jakub',
            bank_key, 
            aspsp_name, 
            aspsp_country, 
            session_id, 
            account_uids, 
            COALESCE(accounts_data, '[]'), 
            'Jakub', 
            valid_until, 
            created_at, 
            updated_at
          FROM _bank_connections_old;
          DROP TABLE _bank_connections_old;
        `);
      }
    } else {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS bank_connections (
          id TEXT PRIMARY KEY,
          bank_key TEXT NOT NULL,
          aspsp_name TEXT NOT NULL,
          aspsp_country TEXT NOT NULL,
          session_id TEXT NOT NULL,
          account_uids TEXT NOT NULL,
          accounts_data TEXT NOT NULL DEFAULT '[]',
          owner_name TEXT NOT NULL DEFAULT 'Jakub',
          valid_until TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_cache (
        account_id TEXT PRIMARY KEY,
        balances_json TEXT,
        transactions_json TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  saveAccountBalances(accountId: string, balances: unknown[]): void {
    const now = Date.now();
    const jsonStr = JSON.stringify(balances);
    this.db.prepare(`
      INSERT INTO account_cache (account_id, balances_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        balances_json = excluded.balances_json,
        updated_at = excluded.updated_at
    `).run(accountId, jsonStr, now);
  }

  getAccountBalances(accountId: string): unknown[] | null {
    const row = this.db.prepare('SELECT balances_json FROM account_cache WHERE account_id = ?').get(accountId) as { balances_json?: string } | undefined;
    if (!row || !row.balances_json) return null;
    try {
      return JSON.parse(row.balances_json);
    } catch {
      return null;
    }
  }

  saveAccountTransactions(accountId: string, transactions: unknown[]): void {
    const now = Date.now();
    const jsonStr = JSON.stringify(transactions);
    this.db.prepare(`
      INSERT INTO account_cache (account_id, transactions_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        transactions_json = excluded.transactions_json,
        updated_at = excluded.updated_at
    `).run(accountId, jsonStr, now);
  }

  getAccountTransactions(accountId: string): unknown[] | null {
    const row = this.db.prepare('SELECT transactions_json FROM account_cache WHERE account_id = ?').get(accountId) as { transactions_json?: string } | undefined;
    if (!row || !row.transactions_json) return null;
    try {
      return JSON.parse(row.transactions_json);
    } catch {
      return null;
    }
  }

  saveBankConnection(conn: {
    id?: string;
    bank_key: string;
    aspsp_name: string;
    aspsp_country: string;
    session_id: string;
    account_uids: string[];
    accounts_data?: unknown[];
    owner_name?: string;
    valid_until: string;
  }): string {
    const now = Date.now();
    const owner = (conn.owner_name || 'Jakub').trim() || 'Jakub';

    let targetId = conn.id;
    if (!targetId) {
      const bySession = this.db.prepare('SELECT id FROM bank_connections WHERE session_id = ?').get(conn.session_id) as { id: string } | undefined;
      if (bySession) {
        targetId = bySession.id;
      } else {
        const byBankAndOwner = this.db.prepare('SELECT id FROM bank_connections WHERE bank_key = ? AND LOWER(owner_name) = LOWER(?)').get(conn.bank_key, owner) as { id: string } | undefined;
        if (byBankAndOwner) {
          targetId = byBankAndOwner.id;
        } else {
          targetId = `${conn.bank_key}_${owner.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
        }
      }
    }

    this.db.prepare(`
      INSERT INTO bank_connections (id, bank_key, aspsp_name, aspsp_country, session_id, account_uids, accounts_data, owner_name, valid_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        bank_key = excluded.bank_key,
        aspsp_name = excluded.aspsp_name,
        aspsp_country = excluded.aspsp_country,
        session_id = excluded.session_id,
        account_uids = excluded.account_uids,
        accounts_data = excluded.accounts_data,
        owner_name = excluded.owner_name,
        valid_until = excluded.valid_until,
        updated_at = excluded.updated_at
    `).run(
      targetId,
      conn.bank_key,
      conn.aspsp_name,
      conn.aspsp_country,
      conn.session_id,
      JSON.stringify(conn.account_uids),
      JSON.stringify(conn.accounts_data || []),
      owner,
      conn.valid_until,
      now,
      now,
    );

    return targetId;
  }

  getBankConnection(idOrKey: string): BankConnection | null {
    const row = this.db.prepare(
      'SELECT * FROM bank_connections WHERE id = ? OR bank_key = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(idOrKey, idOrKey) as
      | {
          id: string;
          bank_key: string;
          aspsp_name: string;
          aspsp_country: string;
          session_id: string;
          account_uids: string;
          accounts_data: string;
          owner_name: string;
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

  getAllBankConnections(ownerFilter?: string): BankConnection[] {
    let query = 'SELECT * FROM bank_connections';
    const params: unknown[] = [];
    if (ownerFilter && ownerFilter.trim()) {
      query += ' WHERE LOWER(owner_name) = LOWER(?)';
      params.push(ownerFilter.trim());
    }
    query += ' ORDER BY owner_name ASC, aspsp_name ASC';
    const rows = this.db.prepare(query).all(...params) as Array<{
      id: string;
      bank_key: string;
      aspsp_name: string;
      aspsp_country: string;
      session_id: string;
      account_uids: string;
      accounts_data: string;
      owner_name: string;
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

  deleteBankConnection(idOrKey: string): void {
    this.db.prepare('DELETE FROM bank_connections WHERE id = ? OR bank_key = ?').run(idOrKey, idOrKey);
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

  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
