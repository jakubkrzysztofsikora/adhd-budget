import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../../src/enable-banking/session-store.js';
import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_DB_PATH = `./data/test-sessions-${randomUUID()}.db`;

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(TEST_DB_PATH);
  });

  afterEach(() => {
    store.close();
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
    if (existsSync(`${TEST_DB_PATH}-wal`)) unlinkSync(`${TEST_DB_PATH}-wal`);
    if (existsSync(`${TEST_DB_PATH}-shm`)) unlinkSync(`${TEST_DB_PATH}-shm`);
  });

  it('stores and retrieves a session by token', () => {
    const token = 'test-token-123';
    store.store(token, 'eb-session-1', ['acc-1', 'acc-2'], Date.now() + 3600_000);

    const record = store.getByToken(token);
    expect(record).not.toBeNull();
    expect(record!.eb_session_id).toBe('eb-session-1');
    expect(record!.account_uids).toEqual(['acc-1', 'acc-2']);
  });

  it('returns null for nonexistent token', () => {
    const record = store.getByToken('nonexistent');
    expect(record).toBeNull();
  });

  it('returns null and cleans up expired sessions', () => {
    const token = 'expired-token';
    store.store(token, 'eb-session-1', ['acc-1'], Date.now() - 1000); // already expired

    const record = store.getByToken(token);
    expect(record).toBeNull();
  });

  it('revokes a session', () => {
    const token = 'revoke-me';
    store.store(token, 'eb-session-1', ['acc-1'], Date.now() + 3600_000);

    store.revoke(token);
    const record = store.getByToken(token);
    expect(record).toBeNull();
  });

  it('hides transactions by entry_reference and transaction_id, and keeps them hidden on re-read', () => {
    const keep = { entry_reference: 'O;1', transaction_id: 'Tzox', transaction_amount: { amount: '10.00' } };
    const drop = { entry_reference: 'O;2', transaction_id: 'Tzoy', transaction_amount: { amount: '666.00' } };
    store.saveAccountTransactions('acc-hidden', [keep, drop]);

    const result = store.hideTransactions([{ accountId: 'acc-hidden', tx: drop, reason: 'test:card-chain' }]);
    expect(result).toEqual({ transactions: 1, keysWritten: 2 }); // ref + tid

    const visible = store.getAccountTransactions('acc-hidden') as Array<{ entry_reference: string }>;
    expect(visible.map(t => t.entry_reference)).toEqual(['O;1']);

    // Filtering is identity-based, so it also applies to freshly re-fetched copies
    const refetched = [{ ...keep }, { ...drop }];
    expect(store.filterHiddenTransactions('acc-hidden', refetched).map(t => t.entry_reference)).toEqual(['O;1']);
    expect(store.isTransactionHidden('acc-hidden', { transaction_id: 'Tzoy' })).toBe(true);
    expect(store.isTransactionHidden('acc-hidden', { transaction_id: 'Tzox' })).toBe(false);

    // Raw cache is untouched (soft delete, not physical)
    const raw = store.getDb().prepare('SELECT transactions_json FROM account_cache WHERE account_id = ?').get('acc-hidden') as { transactions_json: string };
    expect(JSON.parse(raw.transactions_json)).toHaveLength(2);

    // Reversible
    expect(store.unhideTransactions({ accountId: 'acc-hidden', reason: 'test:card-chain' })).toBe(2);
    expect((store.getAccountTransactions('acc-hidden') as unknown[]).length).toBe(2);
  });

  it('hides transactions without identifiers via content-hash key', () => {
    const tx = { transaction_amount: { amount: '12.34' }, booking_date: '2026-09-08', remittance_information: ['Z', 'TRANSFER'] };
    store.saveAccountTransactions('acc-hash', [tx]);
    store.hideTransactions([{ accountId: 'acc-hash', tx, reason: 'test:hash' }]);
    expect(store.filterHiddenTransactions('acc-hash', [tx])).toHaveLength(0);
    expect(store.filterHiddenTransactions('acc-hash', [{ ...tx, transaction_amount: { amount: '12.35' } }])).toHaveLength(1);
  });

  it('applies tombstones added after a read to the same (cached) array on subsequent reads', () => {
    const a = { entry_reference: 'L;1', transaction_id: 'Tl1', transaction_amount: { amount: '50.00' } };
    const b = { entry_reference: 'L;2', transaction_id: 'Tl2', transaction_amount: { amount: '60.00' } };
    const cachedArray = [a, b];

    // read before the hide: both visible
    expect(store.filterHiddenTransactions('acc-late', cachedArray)).toHaveLength(2);
    // hide after the array was cached
    store.hideTransactions([{ accountId: 'acc-late', tx: a, reason: 'test:late' }]);
    // same array object, next read: tombstone applies without any cache invalidation
    expect(store.filterHiddenTransactions('acc-late', cachedArray)).toHaveLength(1);
    expect((store.filterHiddenTransactions('acc-late', cachedArray) as Array<{ entry_reference: string }>)[0].entry_reference).toBe('L;2');
  });

  it('does not over-hide identical-content twins when identifiers differ', () => {
    const twinA = { entry_reference: 'A;1', transaction_id: 'Ta', transaction_amount: { amount: '100.00' }, credit_debit_indicator: 'DBIT', booking_date: '2026-09-08', remittance_information: ['Z', 'TRANSFER'] };
    const twinB = { entry_reference: 'B;1', transaction_id: 'Tb', transaction_amount: { amount: '100.00' }, credit_debit_indicator: 'DBIT', booking_date: '2026-09-08', remittance_information: ['Z', 'TRANSFER'] };
    store.saveAccountTransactions('acc-twin', [twinA, twinB]);
    store.hideTransactions([{ accountId: 'acc-twin', tx: twinA, reason: 'test:twin' }]);
    const visible = store.getAccountTransactions('acc-twin') as Array<{ entry_reference: string }>;
    expect(visible.map(t => t.entry_reference)).toEqual(['B;1']);
  });

  it('cleanup removes expired sessions', () => {
    store.store('active', 'eb-1', ['acc-1'], Date.now() + 3600_000);
    store.store('expired-1', 'eb-2', ['acc-2'], Date.now() - 1000);
    store.store('expired-2', 'eb-3', ['acc-3'], Date.now() - 2000);

    const removed = store.cleanup();
    expect(removed).toBe(2);

    expect(store.getByToken('active')).not.toBeNull();
    expect(store.getByToken('expired-1')).toBeNull();
  });

  it('stores tokens as hashes (not plaintext)', () => {
    const token = 'my-secret-token';
    store.store(token, 'eb-session-1', ['acc-1'], Date.now() + 3600_000);

    // Access the DB directly to verify hash storage
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const row = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toHaveLength(64); // SHA-256 hex
  });

  it('handles concurrent store/retrieve', () => {
    for (let i = 0; i < 100; i++) {
      store.store(`token-${i}`, `eb-${i}`, [`acc-${i}`], Date.now() + 3600_000);
    }
    for (let i = 0; i < 100; i++) {
      const record = store.getByToken(`token-${i}`);
      expect(record).not.toBeNull();
      expect(record!.eb_session_id).toBe(`eb-${i}`);
    }
  });

  it('allows multiple people to connect accounts from the same bank without overwriting', () => {
    // Jakub connects PKO Bank Polski
    const id1 = store.saveBankConnection({
      bank_key: 'pko_bp',
      aspsp_name: 'PKO Bank Polski',
      aspsp_country: 'PL',
      session_id: 'session-jakub-pko',
      account_uids: ['acc-jakub-pko-1', 'acc-jakub-pko-2'],
      owner_name: 'Jakub',
      valid_until: '2026-12-01T00:00:00Z',
    });

    // Karolina also connects PKO Bank Polski
    const id2 = store.saveBankConnection({
      bank_key: 'pko_bp',
      aspsp_name: 'PKO Bank Polski',
      aspsp_country: 'PL',
      session_id: 'session-karolina-pko',
      account_uids: ['acc-karolina-pko-1'],
      owner_name: 'Karolina',
      valid_until: '2026-12-01T00:00:00Z',
    });

    expect(id1).not.toBe(id2);

    const all = store.getAllBankConnections();
    expect(all).toHaveLength(2);

    const jakubConn = all.find(c => c.owner_name === 'Jakub');
    const karolinaConn = all.find(c => c.owner_name === 'Karolina');

    expect(jakubConn).toBeDefined();
    expect(jakubConn!.bank_key).toBe('pko_bp');
    expect(jakubConn!.account_uids).toEqual(['acc-jakub-pko-1', 'acc-jakub-pko-2']);

    expect(karolinaConn).toBeDefined();
    expect(karolinaConn!.bank_key).toBe('pko_bp');
    expect(karolinaConn!.account_uids).toEqual(['acc-karolina-pko-1']);

    // Test owner filtering
    const onlyKarolina = store.getAllBankConnections('Karolina');
    expect(onlyKarolina).toHaveLength(1);
    expect(onlyKarolina[0].owner_name).toBe('Karolina');

    // Deleting Karolina's connection leaves Jakub's intact
    store.deleteBankConnection(id2);
    const afterDelete = store.getAllBankConnections();
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0].owner_name).toBe('Jakub');
  });

  it('migrates legacy bank_connections schema seamlessly', () => {
    const legacyDbPath = `./data/test-legacy-${randomUUID()}.db`;
    const Database = require('better-sqlite3');
    const db = new Database(legacyDbPath);
    // Create old schema
    db.exec(`
      CREATE TABLE bank_connections (
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
      INSERT INTO bank_connections (bank_key, aspsp_name, aspsp_country, session_id, account_uids, valid_until, created_at, updated_at)
      VALUES ('pko_bp', 'PKO Bank Polski', 'PL', 'legacy-sess-1', '["legacy-acc-1"]', '2026-12-01', 1000, 1000);
    `);
    db.close();

    // Now open via SessionStore (triggers migration)
    const migratedStore = new SessionStore(legacyDbPath);
    const conns = migratedStore.getAllBankConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0].bank_key).toBe('pko_bp');
    expect(conns[0].session_id).toBe('legacy-sess-1');
    expect(conns[0].owner_name).toBe('Jakub');
    expect(conns[0].id).toBe('pko_bp_jakub');

    // Now adding a new person to the same bank works after migration
    migratedStore.saveBankConnection({
      bank_key: 'pko_bp',
      aspsp_name: 'PKO Bank Polski',
      aspsp_country: 'PL',
      session_id: 'new-karolina-sess',
      account_uids: ['karolina-acc'],
      owner_name: 'Karolina',
      valid_until: '2026-12-01',
    });

    const both = migratedStore.getAllBankConnections();
    expect(both).toHaveLength(2);
    migratedStore.close();
    if (existsSync(legacyDbPath)) unlinkSync(legacyDbPath);
  });

  it('manages manual and offline wealth accounts with initial seed data and CRUD operations', () => {
    // Check seeded accounts
    const initial = store.getAllManualAccounts();
    expect(initial.length).toBeGreaterThanOrEqual(6);

    const revPln = initial.find(a => a.id === 'rev-vault-pln');
    expect(revPln).toBeDefined();
    expect(revPln!.balance).toBe(43701);
    expect(revPln!.currency).toBe('PLN');

    const revEur = initial.find(a => a.id === 'rev-vault-eur');
    expect(revEur).toBeDefined();
    expect(revEur!.balance).toBe(8530);
    expect(revEur!.currency).toBe('EUR');

    const btc = initial.find(a => a.id === 'crypto-btc');
    expect(btc).toBeDefined();
    expect(btc!.balance).toBe(0.069);
    expect(btc!.currency).toBe('BTC');

    const eth = initial.find(a => a.id === 'crypto-eth');
    expect(eth).toBeDefined();
    expect(eth!.balance).toBe(0.5);

    const xtb = initial.find(a => a.id === 'inv-xtb');
    expect(xtb).toBeDefined();
    expect(xtb!.balance).toBe(11000);

    const vault = initial.find(a => a.id === 'vault-home');
    expect(vault).toBeDefined();
    expect(vault!.balance).toBe(20000);

    // Update balance
    store.updateManualAccountBalance('rev-vault-pln', 45000);
    expect(store.getManualAccount('rev-vault-pln')!.balance).toBe(45000);

    // Add new asset for Arleta
    store.saveManualAccount({
      id: 'arleta-savings',
      name: 'Konto Oszczędnościowe',
      type: 'savings_vault',
      balance: 15000,
      currency: 'PLN',
      owner_name: 'Arleta',
      institution: 'mBank',
      notes: 'Oszczędności Arlety',
    });

    const arletaAccs = store.getAllManualAccounts('Arleta');
    expect(arletaAccs).toHaveLength(1);
    expect(arletaAccs[0].name).toBe('Konto Oszczędnościowe');
    expect(arletaAccs[0].balance).toBe(15000);

    // Delete asset
    store.deleteManualAccount('arleta-savings');
    expect(store.getManualAccount('arleta-savings')).toBeNull();
  });

  it('persists and retrieves pending bank SCA connection attempts across reboots', () => {
    const state = 'connect_pko_bp_test-state-123';
    store.savePendingConnect(state, {
      bankKey: 'pko_bp',
      aspspName: 'PKO Bank Polski',
      aspspCountry: 'PL',
      ownerName: 'Arleta',
    });

    const retrieved = store.getPendingConnect(state);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.bankKey).toBe('pko_bp');
    expect(retrieved!.aspspName).toBe('PKO Bank Polski');
    expect(retrieved!.ownerName).toBe('Arleta');

    store.deletePendingConnect(state);
    expect(store.getPendingConnect(state)).toBeNull();
  });

  it('strictly isolates connections when multiple household members connect the same bank', () => {
    // 1. Jakub connects PKO BP
    const jakubId = store.saveBankConnection({
      bank_key: 'pko_bp',
      aspsp_name: 'PKO Bank Polski',
      aspsp_country: 'PL',
      session_id: 'eb-sess-jakub',
      account_uids: ['acc-jakub-1', 'acc-jakub-2'],
      owner_name: 'Jakub',
      valid_until: '2026-12-01',
    });

    // 2. Arleta connects PKO BP
    const arletaId = store.saveBankConnection({
      bank_key: 'pko_bp',
      aspsp_name: 'PKO Bank Polski',
      aspsp_country: 'PL',
      session_id: 'eb-sess-arleta',
      account_uids: ['acc-arleta-1'],
      owner_name: 'Arleta',
      valid_until: '2026-12-01',
    });

    expect(jakubId).toBe('pko_bp_jakub');
    expect(arletaId).toBe('pko_bp_arleta');

    // Both must exist and have correct accounts
    const all = store.getAllBankConnections();
    expect(all).toHaveLength(2);
    expect(store.getBankConnection('pko_bp_jakub')!.account_uids).toEqual(['acc-jakub-1', 'acc-jakub-2']);
    expect(store.getBankConnection('pko_bp_arleta')!.account_uids).toEqual(['acc-arleta-1']);

    // Deleting Arleta's connection MUST NOT delete Jakub's connection
    store.deleteBankConnection(arletaId);
    expect(store.getBankConnection('pko_bp_arleta')).toBeNull();
    expect(store.getBankConnection('pko_bp_jakub')).not.toBeNull();
    expect(store.getBankConnection('pko_bp_jakub')!.account_uids).toEqual(['acc-jakub-1', 'acc-jakub-2']);
  });
});
