import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClientRegistry } from '../../src/auth/client-registry.js';
import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_DB = `./data/test-clients-${randomUUID()}.db`;

describe('ClientRegistry', () => {
  let registry: ClientRegistry;

  beforeEach(() => {
    registry = new ClientRegistry(TEST_DB);
  });

  afterEach(() => {
    registry.close();
    for (const ext of ['', '-wal', '-shm']) {
      if (existsSync(`${TEST_DB}${ext}`)) unlinkSync(`${TEST_DB}${ext}`);
    }
  });

  it('registers a client and retrieves it by ID', () => {
    const client = registry.registerClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });

    expect(client.client_id).toBeDefined();
    expect(client.client_id_issued_at).toBeDefined();

    const retrieved = registry.getClient(client.client_id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.client_name).toBe('Claude');
  });

  it('returns undefined for nonexistent client', () => {
    expect(registry.getClient('nonexistent')).toBeUndefined();
  });

  it('rejects redirect URIs not in allowlist', () => {
    expect(() => registry.registerClient({
      redirect_uris: ['https://evil.com/callback'],
      client_name: 'Malicious',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    })).toThrow('Redirect URI not allowed');
  });

  it('allows Claude.ai callback URL', () => {
    const client = registry.registerClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
    expect(client.client_id).toBeDefined();
  });

  it('allows localhost callback for Claude Code', () => {
    const client = registry.registerClient({
      redirect_uris: ['http://localhost:3000/callback'],
      client_name: 'Claude Code',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
    expect(client.client_id).toBeDefined();
  });

  it('allows 127.0.0.1 callback for Claude Code', () => {
    const client = registry.registerClient({
      redirect_uris: ['http://127.0.0.1:8080/callback'],
      client_name: 'Claude Code',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
    expect(client.client_id).toBeDefined();
  });
});
