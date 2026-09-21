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

export interface ManualAccount {
  id: string;
  name: string;
  type: 'savings_vault' | 'crypto' | 'investments' | 'physical_vault' | 'other';
  balance: number;
  currency: string;
  owner_name: string;
  institution?: string;
  notes?: string;
  updated_at: number;
}

export interface HiddenTransactionRow {
  account_id: string;
  tx_key: string;
  reason: string;
  payload: string | null;
  hidden_at: number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Stable identity keys for a raw Enable Banking transaction.
 *
 * Both `entry_reference` and `transaction_id` are emitted (when present) so a
 * tombstone matches regardless of which identifier a caller has at hand —
 * list endpoints carry `entry_reference`, while `getTransactionDetails` is
 * addressed by `transaction_id`. Only when neither identifier exists does the
 * key fall back to a content hash (date + amount + direction + remittance).
 *
 * Known ceilings:
 * - A transaction whose bank-issued identifiers change after booking
 *   (pending → booked) will not match its tombstone.
 * - The hash is deliberately NOT emitted alongside identifiers — two
 *   genuinely identical transactions (same date/amount/direction/remittance)
 *   would otherwise be hidden together, silently dropping an innocent one.
 * - For transactions with no identifiers at all, identical-content twins are
 *   indistinguishable and are hidden together by design.
 */
export function transactionKeyCandidates(tx: unknown): string[] {
  const t = (tx || {}) as {
    entry_reference?: unknown;
    transaction_id?: unknown;
    transaction_amount?: { amount?: unknown };
    credit_debit_indicator?: unknown;
    booking_date?: unknown;
    value_date?: unknown;
    transaction_date?: unknown;
    remittance_information?: unknown;
    remittance_information_unstructured?: unknown;
  };
  const keys: string[] = [];
  if (t.entry_reference) keys.push(`ref:${String(t.entry_reference)}`);
  if (t.transaction_id) keys.push(`tid:${String(t.transaction_id)}`);
  if (keys.length > 0) return keys;

  const amount = t.transaction_amount?.amount ?? '';
  const date = t.booking_date || t.value_date || t.transaction_date || '';
  const indicator = t.credit_debit_indicator ?? '';
  const remittance = JSON.stringify(
    t.remittance_information ?? t.remittance_information_unstructured ?? '',
  );
  keys.push(`hash:${createHash('sha1').update(`${String(date)}|${String(amount)}|${String(indicator)}|${remittance}`).digest('hex')}`);
  return keys;
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

      CREATE TABLE IF NOT EXISTS manual_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        balance REAL NOT NULL,
        currency TEXT NOT NULL,
        owner_name TEXT NOT NULL DEFAULT 'Jakub',
        institution TEXT,
        notes TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_connects (
        state TEXT PRIMARY KEY,
        bank_key TEXT NOT NULL,
        aspsp_name TEXT NOT NULL,
        aspsp_country TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hidden_transactions (
        account_id TEXT NOT NULL,
        tx_key TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        payload TEXT,
        hidden_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, tx_key)
      );

      CREATE INDEX IF NOT EXISTS idx_hidden_transactions_account ON hidden_transactions(account_id);
    `);

    // Seed default manual offline assets if empty
    const countRow = this.db.prepare('SELECT count(*) as count FROM manual_accounts').get() as { count: number };
    if (countRow.count === 0) {
      const insertStmt = this.db.prepare(`
        INSERT INTO manual_accounts (id, name, type, balance, currency, owner_name, institution, notes, updated_at)
        VALUES (@id, @name, @type, @balance, @currency, @owner_name, @institution, @notes, @updated_at)
      `);
      const now = Date.now();
      const seedAccounts: Array<ManualAccount> = [
        {
          id: 'rev-vault-pln',
          name: 'Revolut Savings Vault (PLN)',
          type: 'savings_vault',
          balance: 43701,
          currency: 'PLN',
          owner_name: 'Jakub',
          institution: 'Revolut',
          notes: 'Sejf oszczędnościowy PLN',
          updated_at: now,
        },
        {
          id: 'rev-vault-eur',
          name: 'Revolut Savings Vault (EUR)',
          type: 'savings_vault',
          balance: 8530,
          currency: 'EUR',
          owner_name: 'Jakub',
          institution: 'Revolut',
          notes: 'Sejf oszczędnościowy EUR',
          updated_at: now,
        },
        {
          id: 'crypto-btc',
          name: 'Bitcoin (BTC)',
          type: 'crypto',
          balance: 0.069,
          currency: 'BTC',
          owner_name: 'Jakub',
          institution: 'Crypto Wallet',
          notes: 'Portfel krypto BTC',
          updated_at: now,
        },
        {
          id: 'crypto-eth',
          name: 'Ethereum (ETH)',
          type: 'crypto',
          balance: 0.5,
          currency: 'ETH',
          owner_name: 'Jakub',
          institution: 'Crypto Wallet',
          notes: 'Portfel krypto ETH',
          updated_at: now,
        },
        {
          id: 'inv-xtb',
          name: 'XTB Dom Maklerski',
          type: 'investments',
          balance: 11000,
          currency: 'PLN',
          owner_name: 'Jakub',
          institution: 'XTB',
          notes: 'Rachunek inwestycyjny (akcje / ETF)',
          updated_at: now,
        },
        {
          id: 'vault-home',
          name: 'Sejf Domowy (Złoto i Srebro)',
          type: 'physical_vault',
          balance: 20000,
          currency: 'PLN',
          owner_name: 'Jakub',
          institution: 'Fizyczny sejf domowy',
          notes: 'Metale szlachetne (złoto i srebro)',
          updated_at: now,
        },
      ];

      for (const acc of seedAccounts) {
        insertStmt.run(acc);
      }
    }
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
      const parsed = JSON.parse(row.transactions_json) as unknown[];
      return this.filterHiddenTransactions(accountId, parsed);
    } catch {
      return null;
    }
  }

  /**
   * Soft-delete (tombstone) transactions: the raw data stays in `account_cache`
   * untouched, but every read path that consults `hidden_transactions` filters
   * them out — now and on every future bank re-fetch.
   */
  hideTransactions(entries: Array<{ accountId: string; tx: unknown; reason: string }>): { transactions: number; keysWritten: number } {
    const now = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO hidden_transactions (account_id, tx_key, reason, payload, hidden_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, tx_key) DO UPDATE SET
        reason = excluded.reason,
        payload = excluded.payload,
        hidden_at = excluded.hidden_at
    `);
    let keysWritten = 0;
    const runAll = this.db.transaction((items: Array<{ accountId: string; tx: unknown; reason: string }>) => {
      for (const item of items) {
        const payload = JSON.stringify(item.tx);
        for (const key of transactionKeyCandidates(item.tx)) {
          insert.run(item.accountId, key, item.reason, payload, now);
          keysWritten++;
        }
      }
    });
    runAll(entries);
    return { transactions: entries.length, keysWritten };
  }

  getHiddenTxKeys(accountId: string): Set<string> {
    const rows = this.db.prepare('SELECT tx_key FROM hidden_transactions WHERE account_id = ?').all(accountId) as Array<{ tx_key: string }>;
    return new Set(rows.map(r => r.tx_key));
  }

  filterHiddenTransactions<T>(accountId: string, txs: T[]): T[] {
    if (txs.length === 0) return txs;
    const hidden = this.getHiddenTxKeys(accountId);
    if (hidden.size === 0) return txs;
    return txs.filter(tx => !transactionKeyCandidates(tx).some(k => hidden.has(k)));
  }

  isTransactionHidden(accountId: string, tx: unknown): boolean {
    const hidden = this.getHiddenTxKeys(accountId);
    if (hidden.size === 0) return false;
    return transactionKeyCandidates(tx).some(k => hidden.has(k));
  }

  getHiddenTransactions(accountId?: string): HiddenTransactionRow[] {
    if (accountId) {
      return this.db.prepare('SELECT * FROM hidden_transactions WHERE account_id = ? ORDER BY hidden_at ASC, tx_key ASC').all(accountId) as HiddenTransactionRow[];
    }
    return this.db.prepare('SELECT * FROM hidden_transactions ORDER BY account_id ASC, hidden_at ASC').all() as HiddenTransactionRow[];
  }

  /**
   * Reversibility valve for soft-deletes. At least one filter is required.
   * Returns the number of tombstone key rows removed — a single transaction
   * can carry multiple keys (entry_reference + transaction_id), so this is a
   * row count, not a transaction count.
   */
  unhideTransactions(filter: { accountId?: string; reason?: string }): number {
    if (!filter.accountId && !filter.reason) {
      throw new Error('unhideTransactions requires an accountId or reason filter');
    }
    if (filter.accountId && filter.reason) {
      return this.db.prepare('DELETE FROM hidden_transactions WHERE account_id = ? AND reason = ?').run(filter.accountId, filter.reason).changes;
    }
    if (filter.accountId) {
      return this.db.prepare('DELETE FROM hidden_transactions WHERE account_id = ?').run(filter.accountId).changes;
    }
    return this.db.prepare('DELETE FROM hidden_transactions WHERE reason = ?').run(filter.reason!).changes;
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
    // Try deleting by specific ID first to avoid deleting other users sharing the same bank_key
    const res = this.db.prepare('DELETE FROM bank_connections WHERE id = ?').run(idOrKey);
    if (res.changes === 0) {
      this.db.prepare('DELETE FROM bank_connections WHERE bank_key = ?').run(idOrKey);
    }
  }

  savePendingConnect(state: string, data: { bankKey: string; aspspName: string; aspspCountry: string; ownerName: string }): void {
    this.db.prepare(`
      INSERT INTO pending_connects (state, bank_key, aspsp_name, aspsp_country, owner_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(state) DO UPDATE SET
        bank_key = excluded.bank_key,
        aspsp_name = excluded.aspsp_name,
        aspsp_country = excluded.aspsp_country,
        owner_name = excluded.owner_name,
        created_at = excluded.created_at
    `).run(state, data.bankKey, data.aspspName, data.aspspCountry, data.ownerName, Date.now());
  }

  getPendingConnect(state: string): { bankKey: string; aspspName: string; aspspCountry: string; ownerName: string } | null {
    // 1 hour expiration for pending SCA attempts
    const row = this.db.prepare('SELECT bank_key, aspsp_name, aspsp_country, owner_name, created_at FROM pending_connects WHERE state = ?').get(state) as
      | { bank_key: string; aspsp_name: string; aspsp_country: string; owner_name: string; created_at: number }
      | undefined;
    if (!row) return null;
    if (Date.now() - row.created_at > 3600_000) {
      this.deletePendingConnect(state);
      return null;
    }
    return {
      bankKey: row.bank_key,
      aspspName: row.aspsp_name,
      aspspCountry: row.aspsp_country,
      ownerName: row.owner_name,
    };
  }

  deletePendingConnect(state: string): void {
    this.db.prepare('DELETE FROM pending_connects WHERE state = ?').run(state);
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

  getAllManualAccounts(ownerFilter?: string): ManualAccount[] {
    let query = 'SELECT * FROM manual_accounts';
    const params: string[] = [];
    if (ownerFilter) {
      query += ' WHERE LOWER(owner_name) = LOWER(?)';
      params.push(ownerFilter);
    }
    query += ' ORDER BY type ASC, name ASC';
    return this.db.prepare(query).all(...params) as ManualAccount[];
  }

  getManualAccount(id: string): ManualAccount | null {
    return (this.db.prepare('SELECT * FROM manual_accounts WHERE id = ?').get(id) as ManualAccount) || null;
  }

  saveManualAccount(account: Omit<ManualAccount, 'updated_at'> & { updated_at?: number }): void {
    const now = account.updated_at || Date.now();
    this.db.prepare(`
      INSERT INTO manual_accounts (id, name, type, balance, currency, owner_name, institution, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        balance = excluded.balance,
        currency = excluded.currency,
        owner_name = excluded.owner_name,
        institution = excluded.institution,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `).run(
      account.id,
      account.name,
      account.type,
      account.balance,
      account.currency.toUpperCase(),
      account.owner_name || 'Jakub',
      account.institution || '',
      account.notes || '',
      now,
    );
  }

  updateManualAccountBalance(id: string, balance: number): void {
    this.db.prepare(`
      UPDATE manual_accounts
      SET balance = ?, updated_at = ?
      WHERE id = ?
    `).run(balance, Date.now(), id);
  }

  deleteManualAccount(id: string): void {
    this.db.prepare('DELETE FROM manual_accounts WHERE id = ?').run(id);
  }

  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
