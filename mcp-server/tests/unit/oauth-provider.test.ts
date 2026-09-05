import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { EnableBankingOAuthProvider } from '../../src/auth/oauth-provider.js';
import { SessionStore } from '../../src/enable-banking/session-store.js';

function computeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('EnableBankingOAuthProvider (Simplified OAuth 2.1)', () => {
  const testDataDir = `./data/test-oauth-${randomUUID()}`;
  let provider: EnableBankingOAuthProvider;
  let sessionStore: SessionStore;

  beforeEach(() => {
    sessionStore = new SessionStore(`${testDataDir}/sessions.db`);
    sessionStore.saveBankConnection({
      bank_key: 'pko_bp',
      aspsp_name: 'PKO Bank Polski',
      aspsp_country: 'PL',
      session_id: 'eb-pko-1',
      account_uids: ['pko-acc-1', 'pko-acc-2'],
      valid_until: new Date(Date.now() + 86400000).toISOString(),
    });
    sessionStore.saveBankConnection({
      bank_key: 'revolut',
      aspsp_name: 'Revolut',
      aspsp_country: 'PL',
      session_id: 'eb-rev-1',
      account_uids: ['rev-acc-1'],
      valid_until: new Date(Date.now() + 86400000).toISOString(),
    });

    provider = new EnableBankingOAuthProvider({
      dataDir: testDataDir,
      externalUrl: 'https://adhdbudget.bieda.it',
      staticUsers: new Map([['jakub', 'test_password_123']]),
      defaultUser: 'jakub',
    });
  });

  afterEach(() => {
    provider.close();
    sessionStore.close();
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it('renders HTML authorization page on GET /authorize', async () => {
    const client = provider.clientsStore.registerClient({
      client_name: 'Claude Web Test',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });

    let htmlOutput = '';
    let contentType = '';
    const mockRes = {
      setHeader: (name: string, val: string) => {
        if (name.toLowerCase() === 'content-type') contentType = val;
      },
      send: (html: string) => {
        htmlOutput = html;
      },
      redirect: () => {},
      req: { method: 'GET' },
    } as any;

    await provider.authorize(client, {
      codeChallenge: 'test-challenge',
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      state: 'state-123',
    }, mockRes);

    expect(contentType).toContain('text/html');
    expect(htmlOutput).toContain('Authorize AI Assistant');
    expect(htmlOutput).toContain('Claude Web Test');
    expect(htmlOutput).toContain('PKO Bank Polski');
    expect(htmlOutput).toContain('Revolut');
    expect(htmlOutput).toContain('value="jakub"');
  });

  it('rejects invalid password on POST /authorize with error message in HTML', async () => {
    const client = provider.clientsStore.registerClient({
      client_name: 'Claude Web Test',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });

    let htmlOutput = '';
    const mockRes = {
      setHeader: () => {},
      send: (html: string) => {
        htmlOutput = html;
      },
      redirect: () => {},
      req: {
        method: 'POST',
        body: {
          username: 'jakub',
          password: 'wrong_password',
        },
      },
    } as any;

    await provider.authorize(client, {
      codeChallenge: 'test-challenge',
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      state: 'state-123',
    }, mockRes);

    expect(htmlOutput).toContain('Invalid username or password');
  });

  it('issues code and completes token exchange with access to all accounts', async () => {
    const client = provider.clientsStore.registerClient({
      client_name: 'Claude Web Test',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });

    const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const codeChallenge = computeS256(codeVerifier);

    let redirectUrl = '';
    const mockRes = {
      setHeader: () => {},
      send: () => {},
      redirect: (url: string) => {
        redirectUrl = url;
      },
      req: {
        method: 'POST',
        body: {
          username: 'jakub',
          password: 'test_password_123',
        },
      },
    } as any;

    await provider.authorize(client, {
      codeChallenge,
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      state: 'state-xyz',
    }, mockRes);

    expect(redirectUrl).toContain('https://claude.ai/api/mcp/auth_callback?code=');
    expect(redirectUrl).toContain('&state=state-xyz');

    const urlObj = new URL(redirectUrl);
    const code = urlObj.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // Verify challenge lookup
    const challenge = await provider.challengeForAuthorizationCode(client, code);
    expect(challenge).toBe(codeChallenge);

    // Exchange code for tokens
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code,
      codeVerifier,
      'https://claude.ai/api/mcp/auth_callback',
    );

    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(90 * 24 * 3600);

    // Verify access token gives access to ALL connected accounts
    const authInfo = await provider.verifyAccessToken(tokens.access_token);
    expect(authInfo.extra?.userId).toBe('jakub');
    expect(authInfo.extra?.allAccounts).toBe(true);
    expect(authInfo.extra?.accountUids).toEqual(expect.arrayContaining(['pko-acc-1', 'pko-acc-2', 'rev-acc-1']));

    // Exchange refresh token
    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(tokens.access_token);

    // Verify refreshed access token also works
    const refreshedAuthInfo = await provider.verifyAccessToken(refreshed.access_token);
    expect(refreshedAuthInfo.extra?.userId).toBe('jakub');
    expect(refreshedAuthInfo.extra?.accountUids).toEqual(expect.arrayContaining(['pko-acc-1', 'pko-acc-2', 'rev-acc-1']));
  });
});
