import { randomBytes, createHash } from 'node:crypto';
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
import { createLogger } from '../logger.js';

const logger = createLogger();

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface PendingAuth {
  eb_state: string;
  claude_state: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  created_at: number;
  expires_at: number;
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
  aspspName: string;
  aspspCountry: string;
  enableBankingClient: EnableBankingClient;
}

export class EnableBankingOAuthProvider implements OAuthServerProvider {
  private _clientsStore: ClientRegistry;
  private sessionStore: SessionStore;
  private db: Database.Database;
  private ebClient: EnableBankingClient;
  private externalUrl: string;
  private aspspName: string;
  private aspspCountry: string;

  constructor(options: EnableBankingOAuthProviderOptions) {
    const { dataDir, externalUrl, aspspName, aspspCountry, enableBankingClient } = options;
    mkdirSync(dataDir, { recursive: true });

    this._clientsStore = new ClientRegistry(`${dataDir}/clients.db`);
    this.sessionStore = new SessionStore(`${dataDir}/sessions.db`);

    this.db = new Database(`${dataDir}/oauth.db`);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_auths (
        eb_state TEXT PRIMARY KEY,
        claude_state TEXT NOT NULL,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT DEFAULT 'S256',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
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
    this.externalUrl = externalUrl;
    this.aspspName = aspspName;
    this.aspspCountry = aspspCountry;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const ebState = randomBytes(32).toString('base64url');
    const now = Date.now();

    logger.info({ clientId: client.client_id }, 'oauth.authorize.started');

    // Store pending auth linking EB state -> Claude context
    this.db.prepare(`
      INSERT INTO pending_auths (eb_state, claude_state, client_id, redirect_uri, code_challenge, code_challenge_method, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ebState,
      params.state || '',
      client.client_id,
      params.redirectUri,
      params.codeChallenge,
      'S256',
      now,
      now + 300_000, // 5 min TTL
    );

    try {
      // Call Enable Banking to get bank redirect URL
      const callbackUrl = `${this.externalUrl}/auth/eb-callback`;
      const ebResponse = await this.ebClient.initiateAuth(
        this.aspspName,
        this.aspspCountry,
        callbackUrl,
        ebState,
      );

      logger.info({ clientId: client.client_id }, 'oauth.authorize.redirecting_to_bank');
      res.redirect(ebResponse.url);
    } catch (err) {
      logger.error({ err, clientId: client.client_id }, 'oauth.authorize.failed');
      // Redirect back to client with error
      const errorUrl = new URL(params.redirectUri);
      errorUrl.searchParams.set('error', 'server_error');
      errorUrl.searchParams.set('error_description', 'Failed to initiate bank authorization');
      if (params.state) errorUrl.searchParams.set('state', params.state);
      res.redirect(errorUrl.toString());
    }
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
    const codeHash = hashToken(authorizationCode);
    const record = this.db.prepare(
      'SELECT * FROM auth_codes WHERE code_hash = ? AND used = 0 AND expires_at > ?',
    ).get(codeHash, Date.now()) as AuthCodeRecord | undefined;

    if (!record) {
      logger.warn({ clientId: client.client_id }, 'oauth.token.invalid_code');
      throw new Error('Invalid or expired authorization code');
    }

    // Mark as used (single-use)
    this.db.prepare('UPDATE auth_codes SET used = 1 WHERE code_hash = ?').run(codeHash);

    // Verify binding
    if (record.client_id !== client.client_id) {
      logger.warn({ clientId: client.client_id }, 'oauth.token.client_mismatch');
      throw new Error('Client ID mismatch');
    }
    if (redirectUri && record.redirect_uri !== redirectUri) {
      logger.warn({ clientId: client.client_id }, 'oauth.token.redirect_mismatch');
      throw new Error('Redirect URI mismatch');
    }

    // Generate tokens
    const accessToken = generateToken();
    const refreshToken = generateToken();
    const expiresIn = 3600; // 1 hour

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
      Date.now() + 30 * 24 * 3600_000, // 30 days
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

    // Generate new tokens
    const newAccessToken = generateToken();
    const newRefreshToken = generateToken();
    const expiresIn = 3600;

    this.sessionStore.store(
      newAccessToken,
      record.eb_session_id,
      JSON.parse(record.account_uids),
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
      Date.now() + 30 * 24 * 3600_000,
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
      throw new Error('Invalid or expired access token');
    }

    return {
      token,
      clientId: '', // We don't track client per access token
      scopes: [],
      expiresAt: Math.floor(session.expires_at / 1000),
      extra: {
        ebSessionId: session.eb_session_id,
        accountUids: session.account_uids,
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

  // --- Enable Banking callback handler (not part of OAuthServerProvider) ---

  async handleEbCallback(ebCode: string, ebState: string): Promise<{ redirectUrl: string } | { error: string }> {
    // Look up pending auth
    const pending = this.db.prepare(
      'SELECT * FROM pending_auths WHERE eb_state = ? AND expires_at > ?',
    ).get(ebState, Date.now()) as PendingAuth | undefined;

    if (!pending) {
      logger.warn('oauth.eb_callback.invalid_state');
      return { error: 'Invalid or expired state' };
    }

    // Delete pending auth (single-use)
    this.db.prepare('DELETE FROM pending_auths WHERE eb_state = ?').run(ebState);

    try {
      // Exchange EB code for session
      const session = await this.ebClient.createSession(ebCode);
      const accountUids = session.accounts.map(a => a.uid);

      // Generate MCP authorization code
      const mcpCode = generateToken();
      this.db.prepare(`
        INSERT INTO auth_codes (code_hash, eb_session_id, account_uids, client_id, redirect_uri, code_challenge, created_at, expires_at, used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        hashToken(mcpCode),
        session.session_id,
        JSON.stringify(accountUids),
        pending.client_id,
        pending.redirect_uri,
        pending.code_challenge,
        Date.now(),
        Date.now() + 60_000, // 60 second TTL
      );

      // Build redirect URL back to Claude
      const redirectUrl = new URL(pending.redirect_uri);
      redirectUrl.searchParams.set('code', mcpCode);
      if (pending.claude_state) {
        redirectUrl.searchParams.set('state', pending.claude_state);
      }

      logger.info({ clientId: pending.client_id }, 'oauth.eb_callback.success');
      return { redirectUrl: redirectUrl.toString() };
    } catch (err) {
      logger.error({ err }, 'oauth.eb_callback.session_creation_failed');
      const errorUrl = new URL(pending.redirect_uri);
      errorUrl.searchParams.set('error', 'server_error');
      errorUrl.searchParams.set('error_description', 'Failed to create bank session');
      if (pending.claude_state) errorUrl.searchParams.set('state', pending.claude_state);
      return { redirectUrl: errorUrl.toString() };
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
