import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Response } from 'express';
import { ClientRegistry } from './client-registry.js';
import { SessionStore } from '../enable-banking/session-store.js';
import type { EnableBankingClient } from '../enable-banking/client.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createLogger } from '../logger.js';

const logger = createLogger();

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison between two strings using SHA-256 digested buffers.
 * Eliminates side-channel timing leaks during credential verification.
 */
function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

interface AuthCodeRecord {
  code_hash: string;
  eb_session_id: string;
  account_uids: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  created_at: number;
  expires_at: number;
  used: number;
}

interface RefreshTokenRecord {
  token_hash: string;
  eb_session_id: string;
  account_uids: string;
  client_id: string;
  created_at: number;
  expires_at: number;
  revoked: number;
}

export interface EnableBankingOAuthProviderOptions {
  dataDir: string;
  externalUrl: string;
  aspspName?: string;
  aspspCountry?: string;
  enableBankingClient?: EnableBankingClient | null;
  staticUsers?: Map<string, string>;
  defaultUser?: string;
}

export class EnableBankingOAuthProvider implements OAuthServerProvider {
  private _clientsStore: ClientRegistry;
  private sessionStore: SessionStore;
  private db: Database.Database;
  private ebClient?: EnableBankingClient | null;
  private staticUsers: Map<string, string>;
  private defaultUser: string;

  constructor(options: EnableBankingOAuthProviderOptions) {
    const { dataDir, enableBankingClient, staticUsers, defaultUser } = options;
    mkdirSync(dataDir, { recursive: true });

    this._clientsStore = new ClientRegistry(`${dataDir}/clients.db`);
    this.sessionStore = new SessionStore(`${dataDir}/sessions.db`);

    this.db = new Database(`${dataDir}/oauth.db`);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_codes (
        code_hash TEXT PRIMARY KEY,
        eb_session_id TEXT NOT NULL,
        account_uids TEXT NOT NULL,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        eb_session_id TEXT NOT NULL,
        account_uids TEXT NOT NULL,
        client_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked INTEGER DEFAULT 0
      );
    `);

    this.ebClient = enableBankingClient;
    this.staticUsers = staticUsers && staticUsers.size > 0
      ? staticUsers
      : new Map();
    this.defaultUser = defaultUser || 'jakub';
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const req = (res as Response & { req?: { method?: string; body?: Record<string, unknown> } }).req;
    const method = req?.method || 'GET';

    if (method === 'POST') {
      const body = req?.body || {};
      const username = (typeof body.username === 'string' ? body.username : '').trim();
      const password = (typeof body.password === 'string' ? body.password : '').trim();

      let authenticatedUser: string | null = null;

      // Constant-time credential comparison requiring valid non-empty username
      if (username && password && this.staticUsers.size > 0) {
        for (const [validUser, validPass] of this.staticUsers.entries()) {
          if (safeCompare(username.toLowerCase(), validUser.toLowerCase()) && safeCompare(password, validPass)) {
            authenticatedUser = validUser;
            break;
          }
        }
      }

      if (!authenticatedUser) {
        logger.warn({ clientId: client.client_id, username }, 'oauth.authorize.invalid_credentials');
        this.renderAuthorizationPage(client, params, res, 'Invalid username or password. Please try again.');
        return;
      }

      // Successful authentication: issue authorization code
      const authCode = generateToken();
      const now = Date.now();

      this.db.prepare(`
        INSERT INTO auth_codes (code_hash, eb_session_id, account_uids, client_id, redirect_uri, code_challenge, created_at, expires_at, used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        hashToken(authCode),
        authenticatedUser,
        JSON.stringify(['*']), // '*' indicates access to all connected accounts
        client.client_id,
        params.redirectUri,
        params.codeChallenge,
        now,
        now + 300_000, // 5 min TTL
      );

      logger.info({ clientId: client.client_id, user: authenticatedUser }, 'oauth.authorize.code_issued');

      const redirectUrl = new URL(params.redirectUri);
      redirectUrl.searchParams.set('code', authCode);
      if (params.state) {
        redirectUrl.searchParams.set('state', params.state);
      }

      res.redirect(redirectUrl.toString());
      return;
    }

    // GET request: render the authorization page
    this.renderAuthorizationPage(client, params, res);
  }

  private renderAuthorizationPage(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
    errorMessage?: string,
  ): void {
    const clientName = client.client_name || client.client_id;
    const connections = this.sessionStore.getAllBankConnections();
    const totalAccounts = connections.reduce((sum, c) => sum + c.account_uids.length, 0);

    let cancelUrlString = '#';
    try {
      const parsedCancel = new URL(params.redirectUri);
      if (parsedCancel.protocol === 'http:' || parsedCancel.protocol === 'https:') {
        parsedCancel.searchParams.set('error', 'access_denied');
        parsedCancel.searchParams.set('error_description', 'User denied authorization');
        if (params.state) parsedCancel.searchParams.set('state', params.state);
        cancelUrlString = parsedCancel.toString();
      }
    } catch {
      // Fallback if URL parsing fails
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize AI Assistant — ADHD Budget</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #10b981;
      --danger: #ef4444;
      --border: #334155;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem 1rem;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 90vh;
    }
    .auth-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      max-width: 480px;
      width: 100%;
      padding: 2rem;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    .header {
      text-align: center;
      margin-bottom: 1.5rem;
    }
    .header h1 {
      font-size: 1.5rem;
      margin: 0 0 0.5rem 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    .header p {
      color: var(--muted);
      font-size: 0.9rem;
      margin: 0;
    }
    .client-box {
      background: #090d16;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1.25rem;
      font-size: 0.85rem;
    }
    .client-box strong {
      color: #38bdf8;
    }
    .banks-box {
      background: rgba(16, 185, 129, 0.08);
      border: 1px solid rgba(16, 185, 129, 0.3);
      border-radius: 8px;
      padding: 0.9rem 1rem;
      margin-bottom: 1.5rem;
      font-size: 0.85rem;
    }
    .banks-title {
      font-weight: 600;
      color: var(--success);
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .bank-item {
      display: flex;
      justify-content: space-between;
      color: var(--text);
      padding: 0.25rem 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .bank-item:last-child {
      border-bottom: none;
    }
    .bank-item span.count {
      color: var(--muted);
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid var(--danger);
      color: #f87171;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      margin-bottom: 1.25rem;
      font-size: 0.875rem;
    }
    .form-group {
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      margin-bottom: 0.4rem;
      color: var(--text);
    }
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: 0.65rem 0.85rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #090d16;
      color: var(--text);
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="text"]:focus, input[type="password"]:focus {
      border-color: var(--accent);
    }
    .actions {
      display: flex;
      gap: 0.75rem;
      margin-top: 1.75rem;
    }
    .btn {
      flex: 1;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      font-size: 0.95rem;
      font-weight: 500;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      border: none;
      display: inline-block;
    }
    .btn-primary {
      background: var(--accent);
      color: white;
    }
    .btn-primary:hover {
      background: var(--accent-hover);
    }
    .btn-secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text);
    }
    .footer {
      text-align: center;
      margin-top: 1.25rem;
      font-size: 0.75rem;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="auth-card">
    <div class="header">
      <h1>🏦 ADHD Budget</h1>
      <p>Authorize AI Assistant to Access Polish Banks</p>
    </div>

    ${errorMessage ? `<div class="alert-error">${escapeHtml(errorMessage)}</div>` : ''}

    <div class="client-box">
      <div>Client: <strong>${escapeHtml(clientName)}</strong></div>
      <div style="color: var(--muted); margin-top: 0.25rem; font-size: 0.8rem; word-break: break-all;">
        Redirect: ${escapeHtml(params.redirectUri)}
      </div>
    </div>

    <div class="banks-box">
      <div class="banks-title">
        <span>✓</span> Unified Access to Connected Banks (${totalAccounts} accounts)
      </div>
      ${connections.length > 0 ? connections.map(c => `
        <div class="bank-item">
          <span>${escapeHtml(c.aspsp_name)}</span>
          <span class="count">${c.account_uids.length} account(s)</span>
        </div>
      `).join('') : '<div style="color: var(--muted);">No bank accounts linked yet. Link them in the Bank Hub.</div>'}
    </div>

    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(client.client_id)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}" />
      <input type="hidden" name="response_type" value="code" />
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}" />
      <input type="hidden" name="code_challenge_method" value="S256" />
      ${params.state ? `<input type="hidden" name="state" value="${escapeHtml(params.state)}" />` : ''}
      ${params.scopes && params.scopes.length > 0 ? `<input type="hidden" name="scope" value="${escapeHtml(params.scopes.join(' '))}" />` : ''}

      <div class="form-group">
        <label for="username">Username</label>
        <input 
          id="username" 
          type="text" 
          name="username" 
          value="${escapeHtml(this.defaultUser)}" 
          autocomplete="username" 
          required 
        />
      </div>

      <div class="form-group">
        <label for="password">Password</label>
        <input 
          id="password" 
          type="password" 
          name="password" 
          placeholder="Enter password" 
          autocomplete="current-password" 
          required 
          autofocus 
        />
      </div>

      <div class="actions">
        <a href="${escapeHtml(cancelUrlString)}" class="btn btn-secondary">Deny</a>
        <button type="submit" class="btn btn-primary">Authorize Access</button>
      </div>
    </form>

    <div class="footer">
      Private self-hosted OAuth 2.1 gateway • Jakub Sikora
    </div>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }


  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.db.prepare(
      'SELECT code_challenge FROM auth_codes WHERE code_hash = ? AND used = 0 AND expires_at > ?',
    ).get(hashToken(authorizationCode), Date.now()) as { code_challenge: string } | undefined;

    if (!record) {
      throw new Error('Invalid or expired authorization code');
    }

    return record.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    logger.info({ clientId: client.client_id, hasCode: !!authorizationCode, codeLen: authorizationCode?.length, redirectUri }, 'oauth.token.exchange_started');
    const codeHash = hashToken(authorizationCode);

    // Atomically claim the code (single-use enforcement against TOCTOU race conditions)
    const updateResult = this.db.prepare(
      'UPDATE auth_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND expires_at > ?'
    ).run(codeHash, Date.now());

    if (updateResult.changes === 0) {
      // Replay detection (RFC 6819 §5.2.1.1): if code was previously used, revoke issued tokens
      const existing = this.db.prepare('SELECT used, client_id, eb_session_id FROM auth_codes WHERE code_hash = ?').get(codeHash) as { used: number; client_id: string; eb_session_id: string } | undefined;
      if (existing && existing.used === 1) {
        logger.error({ clientId: client.client_id }, 'oauth.token.code_reuse_detected');
        // Revoke all refresh tokens for this client and session to mitigate compromised code
        this.db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE client_id = ? AND eb_session_id = ?').run(existing.client_id, existing.eb_session_id);
      } else {
        logger.warn({ clientId: client.client_id }, 'oauth.token.invalid_or_expired_code');
      }
      throw new Error('Invalid or expired authorization code');
    }

    const record = this.db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(codeHash) as AuthCodeRecord;

    // Verify client binding
    if (record.client_id !== client.client_id) {
      logger.warn({ clientId: client.client_id }, 'oauth.token.client_mismatch');
      throw new Error('Client ID mismatch');
    }

    // Verify redirect URI binding (RFC 6749 §4.1.3)
    if (record.redirect_uri) {
      if (!redirectUri || record.redirect_uri !== redirectUri) {
        logger.warn({ clientId: client.client_id }, 'oauth.token.redirect_mismatch');
        throw new Error('Redirect URI mismatch');
      }
    }

    // Generate tokens
    const accessToken = generateToken();
    const refreshToken = generateToken();
    const expiresIn = 90 * 24 * 3600; // 90 days — matches EB session validity

    // Store access token -> EB session mapping
    this.sessionStore.store(
      accessToken,
      record.eb_session_id,
      JSON.parse(record.account_uids),
      Date.now() + expiresIn * 1000,
    );

    // Store refresh token
    this.db.prepare(`
      INSERT INTO refresh_tokens (token_hash, eb_session_id, account_uids, client_id, created_at, expires_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(
      hashToken(refreshToken),
      record.eb_session_id,
      record.account_uids,
      client.client_id,
      Date.now(),
      Date.now() + 90 * 24 * 3600_000, // 90 days — sliding, same as access token
    );

    logger.info({ clientId: client.client_id }, 'oauth.token.issued');

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const tokenHash = hashToken(refreshToken);
    const record = this.db.prepare(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0 AND expires_at > ?',
    ).get(tokenHash, Date.now()) as RefreshTokenRecord | undefined;

    if (!record) {
      logger.warn({ clientId: client.client_id }, 'oauth.refresh.invalid_token');
      throw new Error('Invalid or expired refresh token');
    }

    if (record.client_id !== client.client_id) {
      throw new Error('Client ID mismatch');
    }

    // Rotate: revoke old refresh token
    this.db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?').run(tokenHash);

    // Generate new tokens (90 days)
    const newAccessToken = generateToken();
    const newRefreshToken = generateToken();
    const expiresIn = 90 * 24 * 3600;

    this.sessionStore.store(
      newAccessToken,
      record.eb_session_id,
      ['*'],
      Date.now() + expiresIn * 1000,
    );

    this.db.prepare(`
      INSERT INTO refresh_tokens (token_hash, eb_session_id, account_uids, client_id, created_at, expires_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(
      hashToken(newRefreshToken),
      record.eb_session_id,
      record.account_uids,
      client.client_id,
      Date.now(),
      Date.now() + 90 * 24 * 3600_000,
    );

    logger.info({ clientId: client.client_id }, 'oauth.refresh.issued');

    return {
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const session = this.sessionStore.getByToken(token);
    if (!session) {
      throw new InvalidTokenError('Invalid or expired access token');
    }

    // Live resolution of all active bank connections
    const allBankConnections = this.sessionStore.getAllBankConnections();
    const allAccountUids = allBankConnections.flatMap(b => b.account_uids);

    return {
      token,
      clientId: '',
      scopes: ['banking'],
      expiresAt: Math.floor(session.expires_at / 1000),
      extra: {
        userId: session.eb_session_id,
        allAccounts: true,
        accountUids: allAccountUids,
        ebSessionId: session.eb_session_id,
      },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashToken(request.token);

    // Try revoking as access token
    this.sessionStore.revoke(request.token);

    // Try revoking as refresh token
    this.db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?').run(tokenHash);

    logger.info('oauth.token.revoked');
  }

  async handleEbCallback(ebCode: string, _ebState: string): Promise<{ redirectUrl: string } | { error: string }> {
    if (!this.ebClient) {
      return { error: 'Enable Banking client not initialized' };
    }
    try {
      await this.ebClient.createSession(ebCode);
      return { redirectUrl: '/connect?status=connected' };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  close(): void {
    this._clientsStore.close();
    this.sessionStore.close();
    this.db.close();
  }
}

export { EnableBankingOAuthProvider as OAuthProvider };

