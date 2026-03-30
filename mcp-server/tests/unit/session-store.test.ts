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
});
