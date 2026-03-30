---
date: 2026-03-30
commit: 1fafe96
branch: claude/analyze-mcp-banking-oauth-dIdei
ticket: n/a
status: implemented
---
# Plan: Rewrite MCP Server for Enable Banking (TypeScript, Claude-Compatible)

## Summary

Rewrite the MCP server from scratch in TypeScript using the official `@modelcontextprotocol/sdk` (v1.28+). Each bank connection is a **separate MCP server instance** — one instance per ASPSP (bank), configured via environment variables. Claude adds each bank as a separate connector. The server acts as an OAuth 2.1 authorization server for Claude while proxying bank authorization to Enable Banking's JWT + session flow. Streamable HTTP transport on a single `/mcp` endpoint, targeting protocol version `2025-06-18`. Comprehensive automated test suite using Vitest + InMemoryTransport + MCP Validator.

## Why Rewrite (Not Refactor)

The existing Python codebase has:
- 5 separate MCP server files (`mcp_server.py`, `mcp_fastapi_server.py`, `mcp_remote_server.py`, `mcp_server_oauth.py`, `simple_mcp_server.py`) with overlapping/conflicting implementations
- Hand-rolled JSON-RPC, SSE, OAuth — no use of the official MCP SDK
- In-memory OAuth state that doesn't survive restarts
- Mixed sync/async patterns (aiohttp + http.server)
- No TypeScript — missing the best-supported SDK ecosystem

A clean TypeScript rewrite using the official SDK eliminates all protocol compliance risk and gives us first-class Claude compatibility.

## Research References

- MCP Spec 2025-06-18: Streamable HTTP, OAuth 2.1, RFC 9728 Protected Resource Metadata
- MCP Spec 2025-11-25: CIMD, icons, incremental scope consent (backwards-compatible additions)
- Official TypeScript SDK: `@modelcontextprotocol/sdk` v1.28.0
- Enable Banking API: JWT (RS256) auth, `/auth` → `/sessions` → `/accounts` flow
- Enable Banking Sandbox: Free self-service, Mock ASPSP, auto-activated apps
- Testing: `InMemoryTransport`, MCP Validator (Janix-ai), Vitest

## Core Design Decision: One Bank = One MCP Instance

Each bank is deployed as a separate MCP server instance, configured at startup:

```bash
# Revolut connector
ASPSP_NAME=Revolut ASPSP_COUNTRY=GB PORT=8081 node dist/index.js

# PKO BP connector
ASPSP_NAME=PKO_BP ASPSP_COUNTRY=PL PORT=8082 node dist/index.js

# Mock ASPSP (sandbox testing)
ASPSP_NAME=MOCKASPSP_SANDBOX ASPSP_COUNTRY=FI PORT=8083 node dist/index.js
```

In Claude, each is added as a separate connector (e.g., "Revolut Bank", "PKO BP"). This means:
- No bank-picker tool needed — the bank is fixed per instance
- OAuth flow goes straight to the correct bank
- Tools are scoped to one bank's accounts — simpler, clearer
- Claude can query across banks by calling tools on different connectors
- Deployment scales by adding more services to docker-compose

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Claude (MCP Client)                                        │
│                                                             │
│  Connector: "Revolut"     → https://mcp.example.com:8081   │
│  Connector: "PKO BP"      → https://mcp.example.com:8082   │
│  Connector: "Mock Bank"   → https://mcp.example.com:8083   │
└─────┬──────────────┬──────────────┬─────────────────────────┘
      │              │              │
      ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│ MCP Inst │  │ MCP Inst │  │ MCP Inst │   Same Docker image,
│ Revolut  │  │ PKO BP   │  │ Mock     │   different env vars
│ :8081    │  │ :8082    │  │ :8083    │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │              │              │
     └──────────────┴──────────────┘
                    │ JWT Bearer
                    ▼
     ┌──────────────────────────────┐
     │  Enable Banking API          │
     │  api.enablebanking.com       │
     └──────────────────────────────┘
```

### Auth Proxy Flow (The "Simple Proxy" Pattern)

The MCP OAuth flow proxies to Enable Banking's bank authorization:

1. Claude calls `/authorize` on MCP server (e.g., Revolut instance)
2. MCP server stores Claude's `state` + `code_challenge`, calls Enable Banking `POST /auth` with the pre-configured ASPSP name/country and a redirect URL pointing to `/auth/eb-callback`
3. User is redirected to their bank's login page (e.g., Revolut's SCA)
4. Bank redirects back to MCP server `/auth/eb-callback?code=<eb_code>`
5. MCP server exchanges `eb_code` for an Enable Banking session (`POST /sessions`)
6. MCP server generates an MCP authorization code mapped to the EB session ID
7. MCP server redirects back to Claude's `redirect_uri` with `?code=<mcp_code>&state=<claude_state>`
8. Claude exchanges code for MCP access token via `POST /token` (PKCE verified)

The user authenticates with their actual bank once. Claude gets an MCP token that internally maps to the Enable Banking session. Session validity follows the bank's consent period (typically 90-180 days).

## Enable Banking Sandbox Setup (Phase 0)

### Prerequisites (manual, one-time)
1. **Register** at https://enablebanking.com/sign-in (magic link, no password)
2. **Generate RSA key pair** locally:
   ```bash
   openssl genrsa -out keys/enablebanking_private.pem 2048
   openssl rsa -in keys/enablebanking_private.pem -pubout -out keys/enablebanking_public.pem
   ```
3. **Create sandbox application** in Control Panel:
   - Environment: **Sandbox**
   - Upload public key (Option B — bring your own key)
   - Redirect URLs: `http://localhost:8081/auth/eb-callback` (dev), `https://mcp.example.com/auth/eb-callback` (prod)
   - Note the returned `app_id` (UUID)
4. **Configure `.env`**:
   ```bash
   ENABLE_APP_ID=<uuid-from-step-3>
   ENABLE_PRIVATE_KEY_PATH=./keys/enablebanking_private.pem
   ENABLE_API_BASE_URL=https://api.enablebanking.com
   ```
5. **Mock ASPSP data**: Optionally populate test accounts/transactions in the Control Panel → Mock ASPSP tab

### Sandbox Behavior
- Mock ASPSP auto-available for all sandbox apps
- Transactions returned in batches of 10, newest first
- No payment initiation in sandbox
- Full transaction history available for ~1 hour after auth, then limited to 90 days
- Background fetching rate-limited to 4x/day

---

## Phase 1: Project Scaffolding & SDK Setup

### Changes

#### File: `mcp-server/package.json` (Create)
- **What**: New TypeScript project with MCP SDK, Enable Banking deps
- **Rationale**: Clean start with modern tooling
- **Dependencies**:
  ```json
  {
    "dependencies": {
      "@modelcontextprotocol/sdk": "^1.28.0",
      "express": "^5.1.0",
      "better-sqlite3": "^11.0.0",
      "jose": "^6.0.0",
      "express-rate-limit": "^7.0.0",
      "pino": "^9.0.0",
      "pino-pretty": "^13.0.0"
    },
    "devDependencies": {
      "typescript": "^5.7.0",
      "vitest": "^3.0.0",
      "@types/express": "^5.0.0",
      "@types/better-sqlite3": "^7.0.0",
      "tsx": "^4.0.0"
    }
  }
  ```

  **Dependency decisions**:
  - `jose` over `jsonwebtoken`: Modern, ESM-native, TypeScript-first, actively maintained
  - `express-rate-limit`: Required for OAuth endpoint protection (security review)
  - `pino`: Structured logging for audit trail (security review)
  - No `uuid` needed: `crypto.randomUUID()` built into Node 22

#### File: `mcp-server/tsconfig.json` (Create)
- **What**: TypeScript config targeting Node 22, ESM modules
- **Code sketch**:
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "outDir": "dist",
      "rootDir": "src",
      "strict": true,
      "esModuleInterop": true,
      "declaration": true
    },
    "include": ["src"]
  }
  ```

#### File: `mcp-server/vitest.config.ts` (Create)
- **What**: Vitest config for testing
- **Code sketch**:
  ```typescript
  import { defineConfig } from 'vitest/config';
  export default defineConfig({
    test: {
      globals: true,
      testTimeout: 30000,
      include: ['tests/**/*.test.ts'],
    },
  });
  ```

#### File: `mcp-server/src/index.ts` (Create)
- **What**: Entry point — creates Express app, mounts MCP SDK StreamableHTTPServerTransport, starts HTTP server
- **Rationale**: Single entry point, clean startup

#### File: `mcp-server/Dockerfile` (Create)
- **What**: Multi-stage Node 22 Alpine build
- **Code sketch**:
  ```dockerfile
  FROM node:22-alpine AS builder
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci
  COPY . .
  RUN npm run build

  FROM node:22-alpine
  WORKDIR /app
  COPY --from=builder /app/dist ./dist
  COPY --from=builder /app/node_modules ./node_modules
  COPY package*.json ./
  USER node
  EXPOSE 8081
  CMD ["node", "dist/index.js"]
  ```

### Success Criteria

#### Automated Verification
- [x] `npm run build` compiles without errors
- [x] `npm test` runs (even if no tests yet)
- [x] Docker builds successfully
- [x] Server starts and responds to `GET /health` with 200

#### Manual Verification
- [ ] Project structure is clean and readable

### Dependencies
- Requires: nothing
- Blocks: Phase 2, 3, 4

---

## Phase 2: MCP Server Core (Tools + Streamable HTTP)

### Changes

#### File: `mcp-server/src/server.ts` (Create)
- **What**: MCP Server instance using `@modelcontextprotocol/sdk`, registers bank-scoped tools
- **Rationale**: Use the official SDK's `Server` class — handles JSON-RPC, protocol negotiation, capability exchange. Server name includes bank name for identification in Claude.
- **Code sketch**:
  ```typescript
  import { Server } from "@modelcontextprotocol/sdk/server/index.js";

  export function createMcpServer(config: { aspspName: string }) {
    const server = new Server(
      { name: `enable-banking-${config.aspspName.toLowerCase()}`, version: "2.0.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "accounts", description: "List all accounts at this bank with their IDs and types", inputSchema: { type: "object", properties: {} } },
        { name: "balances", description: "Get current balances for an account", inputSchema: { type: "object", properties: { account_id: { type: "string" } }, required: ["account_id"] } },
        { name: "transactions", description: "Query transactions for an account within a date range", inputSchema: { type: "object", properties: { account_id: { type: "string" }, date_from: { type: "string", format: "date" }, date_to: { type: "string", format: "date" } }, required: ["account_id"] } },
        { name: "search", description: "Free-text search over recent transactions", inputSchema: { type: "object", properties: { query: { type: "string" }, account_id: { type: "string" } }, required: ["query"] } },
        { name: "transaction", description: "Get details of a specific transaction", inputSchema: { type: "object", properties: { account_id: { type: "string" }, transaction_id: { type: "string" } }, required: ["account_id", "transaction_id"] } },
      ]
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Route to tool handlers — each receives the EB session from auth context
    });

    return server;
  }
  ```

  **Tool design rationale**: Tools are pure banking data access — no business logic (categorization, projections, budgets). Those belong in a separate layer. Tool names are short since the connector name already identifies the bank. The `search` tool satisfies ChatGPT Developer Mode's required `search` + `fetch` pattern.

#### File: `mcp-server/src/transport.ts` (Create)
- **What**: Express routes for Streamable HTTP — single `/mcp` endpoint with session-mapped transports
- **Rationale**: Use SDK's `NodeStreamableHTTPServerTransport` with session map pattern (one transport per session, one server per session)
- **IMPORTANT**: Use `createMcpExpressApp()` instead of raw `express()` for DNS rebinding protection. Use SDK's `mcpAuthRouter` for OAuth endpoints and `requireBearerAuth` middleware for token validation.
- **Code sketch**:
  ```typescript
  import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.node.js";
  import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
  import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
  import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
  import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

  const app = createMcpExpressApp(); // DNS rebinding protection built-in
  const transports: Map<string, NodeStreamableHTTPServerTransport> = new Map();

  // Mount OAuth routes at expected paths (Claude.ai hardcodes these relative to server URL)
  app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl, baseUrl }));

  const authMiddleware = requireBearerAuth({ ... });

  // POST /mcp — JSON-RPC messages (session-mapped)
  app.post('/mcp', authMiddleware, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session — route to stored transport
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session — create transport + server, store in map
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore: new InMemoryEventStore(),
        onsessioninitialized: (sid) => { transports.set(sid, transport); },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = createMcpServer(config);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } else {
      res.status(400).json({ error: 'Bad request — missing session or not initialize' });
    }
  });

  // GET /mcp — SSE stream for server-initiated messages
  app.get('/mcp', authMiddleware, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    const transport = transports.get(sessionId);
    if (!transport) return res.status(400).send('Invalid session');
    await transport.handleRequest(req, res);
  });

  // DELETE /mcp — Session termination
  app.delete('/mcp', authMiddleware, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    const transport = transports.get(sessionId);
    if (!transport) return res.status(400).send('Invalid session');
    await transport.handleRequest(req, res);
  });
  ```

  **Known Claude.ai quirk**: Claude.ai web hardcodes OAuth endpoint paths (`/authorize`, `/token`, `/register`) relative to the MCP server URL, ignoring metadata. The SDK's `mcpAuthRouter` handles this automatically by serving endpoints at these paths.

#### File: `mcp-server/src/tools/accounts.ts` (Create)
- **What**: Tool handlers for `accounts` and `balances`
- **Rationale**: Clean separation of tool logic from transport

#### File: `mcp-server/src/tools/transactions.ts` (Create)
- **What**: Tool handlers for `transactions`, `transaction`, and `search`
- **Rationale**: `search` does client-side filtering over recent transactions (Enable Banking has no server-side search)

### Success Criteria

#### Automated Verification
- [x] `npm run build` passes
- [x] Unit test: tools list returns all registered tools (InMemoryTransport)
- [x] Unit test: each tool handler returns valid MCP content responses
- [x] Integration test: POST `/mcp` with `initialize` returns valid `InitializeResult`
- [x] Integration test: POST `/mcp` with `tools/list` returns tools array
- [x] Integration test: POST `/mcp` with `tools/call` invokes tool and returns result
- [x] Integration test: GET `/mcp` establishes SSE connection
- [x] Integration test: DELETE `/mcp` terminates session (returns 200, subsequent requests get 404)
- [x] `Mcp-Session-Id` header present on all responses after initialization
- [x] `MCP-Protocol-Version: 2025-06-18` header on responses

#### Manual Verification
- [ ] MCP Inspector can connect and list tools

### Dependencies
- Requires: Phase 1
- Blocks: Phase 3

---

## Phase 3: Enable Banking Integration

### Changes

#### File: `mcp-server/src/enable-banking/client.ts` (Create)
- **What**: Enable Banking API client — JWT generation, all API calls
- **Rationale**: Encapsulate all Enable Banking API interaction
- **Code sketch**:
  ```typescript
  import { SignJWT, importPKCS8 } from 'jose';

  export class EnableBankingClient {
    constructor(
      private appId: string,
      private privateKey: string, // PEM content
      private baseUrl = 'https://api.enablebanking.com'
    ) {}

    private async generateJwt(): Promise<string> {
      const key = await importPKCS8(this.privateKey, 'RS256');
      return new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: this.appId })
        .setIssuer('enablebanking.com')
        .setAudience('api.enablebanking.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(key);
    }

    async listAspsps(country: string) { /* GET /aspsps?country=XX */ }
    async initiateAuth(aspspName: string, country: string, redirectUrl: string, state: string) { /* POST /auth */ }
    async createSession(code: string) { /* POST /sessions */ }
    async getSession(sessionId: string) { /* GET /sessions/{id} */ }
    async getBalances(accountId: string) { /* GET /accounts/{id}/balances */ }
    async getTransactions(accountId: string, dateFrom?: string, dateTo?: string) { /* GET /accounts/{id}/transactions (with pagination via continuation_key) */ }
  }
  ```

#### File: `mcp-server/src/enable-banking/session-store.ts` (Create)
- **What**: SQLite-backed store mapping MCP access token hashes → Enable Banking session IDs + account UIDs
- **Rationale**: Must survive restarts; SQLite is zero-config and file-based. Tokens stored as SHA-256 hashes for defense in depth (DB compromise doesn't leak usable tokens).
- **Code sketch**:
  ```typescript
  import Database from 'better-sqlite3';
  import { createHash } from 'node:crypto';

  function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  export class SessionStore {
    private db: Database.Database;

    constructor(dbPath = './data/sessions.db') {
      this.db = new Database(dbPath, { wal: true }); // WAL mode for concurrent reads
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,       -- SHA-256 of MCP access token
          eb_session_id TEXT NOT NULL,
          account_uids TEXT NOT NULL,         -- JSON array
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
    }

    store(mcpTokenHash: string, ebSessionId: string, accountUids: string[], expiresAt: number) {
      this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?, ?)')
        .run(mcpTokenHash, ebSessionId, JSON.stringify(accountUids), Date.now(), expiresAt);
    }

    getByToken(mcpToken: string): SessionRecord | null {
      const record = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?')
        .get(hashToken(mcpToken));
      if (!record) return null;
      if (Date.now() > record.expires_at) {
        this.revoke(mcpToken);
        return null; // Expired — force re-auth
      }
      return { ...record, account_uids: JSON.parse(record.account_uids) };
    }

    revoke(mcpToken: string) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(mcpToken));
    }

    cleanup() {
      this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    }
  }
  ```

#### Update: `mcp-server/src/tools/*.ts`
- **What**: Wire tool handlers to Enable Banking client using session from auth context
- **Rationale**: Tools need to call Enable Banking API with the user's session

### Success Criteria

#### Automated Verification
- [x] Unit test: JWT generation produces valid RS256 token with correct claims
- [x] Unit test: Enable Banking client methods construct correct API requests (mock HTTP)
- [x] Unit test: Session store CRUD operations work correctly
- [x] Unit test: Transaction pagination handles continuation_key correctly
- [ ] Integration test (sandbox): `initiateAuth` returns redirect URL from Enable Banking sandbox
- [ ] Integration test (sandbox): Full auth → session → accounts → transactions flow against sandbox API

#### Manual Verification
- [ ] Can initiate bank login and see Mock ASPSP redirect

### Dependencies
- Requires: Phase 1
- Blocks: Phase 4

---

## Phase 4: OAuth 2.1 Authorization Server (Auth Proxy)

### Changes

#### File: `mcp-server/src/auth/oauth-provider.ts` (Create)
- **What**: Custom `OAuthServerProvider` implementation that proxies authorization to Enable Banking
- **Rationale**: Implements the SDK's `OAuthServerProvider` interface so we can use `mcpAuthRouter` and `requireBearerAuth` from the SDK. This handles `/.well-known/*`, `/register`, `/authorize`, `/token`, `/revoke` automatically.
- **Endpoints** (served by `mcpAuthRouter`):
  - `GET /.well-known/oauth-protected-resource` — RFC 9728 Protected Resource Metadata
  - `GET /.well-known/oauth-authorization-server` — RFC 8414 server metadata
  - `POST /register` — Dynamic Client Registration (RFC 7591) with redirect_uri allowlist
  - `GET /authorize` — Proxies to Enable Banking bank auth
  - `POST /token` — Exchanges MCP auth code for access token (PKCE verified)
  - `POST /revoke` — Token revocation

- **Security requirements** (from security review):
  1. **DCR redirect_uri allowlist**: Only accept Claude's known callback URLs
  2. **Token generation**: `crypto.randomBytes(32).toString('base64url')` (256 bits)
  3. **Auth code binding**: Codes bound to `client_id`, `redirect_uri`, `code_challenge`
  4. **Token expiry enforcement**: Check `expires_at` on every request
  5. **Token hashing**: Store SHA-256 hash of tokens, not plaintext
  6. **Rate limiting**: 10 req/15min on `/authorize` and `/token`, 5 req/hour on `/register`
  7. **Audit logging**: Log all OAuth events (no secrets/tokens in logs)

- **Code sketch**:
  ```typescript
  import { randomBytes, createHash } from 'node:crypto';

  // --- Security utilities ---
  function generateToken(): string {
    return randomBytes(32).toString('base64url'); // 256 bits of entropy
  }

  function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // --- DCR redirect_uri allowlist ---
  const ALLOWED_REDIRECT_PATTERNS = [
    /^https:\/\/(www\.)?claude\.ai\/api\/mcp\/auth_callback$/,
    /^https:\/\/(www\.)?claude\.com\/api\/mcp\/auth_callback$/,
    /^http:\/\/(localhost|127\.0\.0\.1):\d+\/callback$/,  // Claude Code CLI
  ];

  // --- SQLite tables ---
  // pending_auths: links MCP OAuth flow to Enable Banking auth flow
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_auths (
      eb_state TEXT PRIMARY KEY,           -- random state sent to Enable Banking
      claude_state TEXT NOT NULL,           -- Claude's original state parameter
      client_id TEXT NOT NULL,              -- registered client ID
      redirect_uri TEXT NOT NULL,           -- Claude's redirect URI
      code_challenge TEXT NOT NULL,         -- PKCE code challenge
      code_challenge_method TEXT DEFAULT 'S256',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL           -- 5 min TTL
    )
  `);

  // auth_codes: single-use, short-lived, bound to client
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_codes (
      code_hash TEXT PRIMARY KEY,           -- SHA-256 of the auth code
      eb_session_id TEXT NOT NULL,
      account_uids TEXT NOT NULL,           -- JSON array
      client_id TEXT NOT NULL,              -- bound to originating client
      redirect_uri TEXT NOT NULL,           -- bound to originating redirect
      code_challenge TEXT NOT NULL,         -- for PKCE verification
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,          -- 60 second TTL
      used INTEGER DEFAULT 0               -- single-use flag
    )
  `);

  // --- /authorize handler (called by mcpAuthRouter) ---
  async authorize(req, res) {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;
    // 1. Validate client exists and redirect_uri matches registration
    // 2. Generate cryptographic eb_state for Enable Banking
    const ebState = randomBytes(32).toString('base64url');
    // 3. Store pending auth linking eb_state → claude context
    db.prepare('INSERT INTO pending_auths ...').run(
      ebState, state, client_id, redirect_uri, code_challenge,
      code_challenge_method, Date.now(), Date.now() + 300_000
    );
    // 4. Call Enable Banking POST /auth with pre-configured ASPSP
    const ebResponse = await enableBanking.initiateAuth(
      config.aspspName, config.aspspCountry,
      `${externalUrl}/auth/eb-callback`,
      ebState
    );
    // 5. Redirect user to bank login
    res.redirect(ebResponse.url);
  }

  // --- /auth/eb-callback (NOT part of mcpAuthRouter — standalone route) ---
  app.get('/auth/eb-callback', async (req, res) => {
    const { code: ebCode, state: ebState } = req.query;
    // 1. Look up pending auth by ebState (verify not expired)
    const pending = db.prepare('SELECT * FROM pending_auths WHERE eb_state = ? AND expires_at > ?')
      .get(ebState, Date.now());
    if (!pending) return res.status(400).send('Invalid or expired state');
    // 2. Delete pending auth (single-use)
    db.prepare('DELETE FROM pending_auths WHERE eb_state = ?').run(ebState);
    // 3. Exchange ebCode for Enable Banking session
    const session = await enableBanking.createSession(ebCode);
    // 4. Generate MCP authorization code (short-lived, single-use)
    const mcpCode = generateToken();
    db.prepare('INSERT INTO auth_codes ...').run(
      hashToken(mcpCode), session.session_id, JSON.stringify(session.accounts),
      pending.client_id, pending.redirect_uri, pending.code_challenge,
      Date.now(), Date.now() + 60_000
    );
    // 5. Redirect to Claude with MCP auth code
    const redirectUrl = new URL(pending.redirect_uri);
    redirectUrl.searchParams.set('code', mcpCode);
    redirectUrl.searchParams.set('state', pending.claude_state);
    res.redirect(redirectUrl.toString());
  });

  // --- /token handler (called by mcpAuthRouter) ---
  async exchangeToken(req) {
    const { grant_type, code, code_verifier, redirect_uri, client_id } = req.body;
    // 1. Look up auth code (by hash)
    const record = db.prepare('SELECT * FROM auth_codes WHERE code_hash = ? AND used = 0 AND expires_at > ?')
      .get(hashToken(code), Date.now());
    if (!record) throw new Error('invalid_grant');
    // 2. Mark as used (single-use)
    db.prepare('UPDATE auth_codes SET used = 1 WHERE code_hash = ?').run(hashToken(code));
    // 3. Verify binding: client_id and redirect_uri must match
    if (record.client_id !== client_id || record.redirect_uri !== redirect_uri) throw new Error('invalid_grant');
    // 4. Verify PKCE
    if (!verifyPkce(code_verifier, record.code_challenge)) throw new Error('invalid_grant');
    // 5. Generate tokens
    const accessToken = generateToken();
    const refreshToken = generateToken();
    sessionStore.store(hashToken(accessToken), record.eb_session_id, JSON.parse(record.account_uids),
      Date.now() + 3600_000); // 1 hour expiry
    return { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: refreshToken };
  }
  ```

#### File: `mcp-server/src/auth/client-registry.ts` (Create)
- **What**: SQLite-backed DCR store with redirect_uri allowlist enforcement
- **Rationale**: Claude registers itself via DCR; must persist across restarts. MUST reject redirect_uris not matching allowlist to prevent authorization code theft.
- **Known Claude DCR quirks**:
  - Claude sends `client_name: "Claude"` but may omit `scope` — apply minimal defaults
  - Claude may omit RFC 8707 `resource` parameter — handle gracefully
  - Claude Code may use `localhost` vs `127.0.0.1` inconsistently — normalize loopback addresses

#### File: `mcp-server/src/auth/pkce.ts` (Create)
- **What**: PKCE utilities — S256 code challenge verification
- **Rationale**: PKCE is mandatory for OAuth 2.1 public clients
- **Code sketch**:
  ```typescript
  import { createHash } from 'node:crypto';

  export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
    const computed = createHash('sha256').update(codeVerifier).digest('base64url');
    return computed === codeChallenge;
  }
  ```

### Success Criteria

#### Automated Verification
- [x] Unit test: PKCE S256 challenge/verifier validation
- [x] Unit test: DCR creates and retrieves client registrations
- [x] Unit test: Token generation and validation
- [x] Unit test: Auth middleware rejects missing/invalid tokens with correct WWW-Authenticate header
- [x] Integration test: Server works without auth when no EB credentials configured
- [x] Integration test: Well-known endpoints return 404 when no OAuth configured
- [ ] Integration test: Full OAuth flow with EB credentials (requires sandbox setup)
- [ ] **Claude compatibility test**: Simulated Claude DCR + auth flow succeeds (mock Claude redirect URI)

#### Manual Verification
- [ ] MCP Inspector can complete OAuth flow against local server
- [ ] Claude Desktop can connect via remote MCP connector

### Dependencies
- Requires: Phase 2, Phase 3
- Blocks: Phase 5

---

## Phase 5: Automated Test Suite

### Testing Layers

#### Layer 1: Unit Tests (InMemoryTransport, no network)

**File: `mcp-server/tests/unit/tools.test.ts`** (Create)
```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";

describe('MCP Tools', () => {
  let client: Client;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(mockEnableBankingClient);
    await server.connect(serverTransport);
    client = new Client({ name: "test", version: "1.0" });
    await client.connect(clientTransport);
  });

  test('lists all tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toContain('accounts.list');
    expect(tools.map(t => t.name)).toContain('transactions.query');
  });

  test('accounts.list returns accounts', async () => {
    const result = await client.callTool({ name: 'accounts.list', arguments: {} });
    expect(result.content[0].type).toBe('text');
  });
});
```

**File: `mcp-server/tests/unit/enable-banking.test.ts`** (Create)
- JWT generation tests
- API client request construction tests (mocked HTTP)

**File: `mcp-server/tests/unit/oauth.test.ts`** (Create)
- PKCE validation tests
- DCR tests
- Token lifecycle tests

**File: `mcp-server/tests/unit/session-store.test.ts`** (Create)
- CRUD operations
- Expiry cleanup
- Concurrent access

#### Layer 2: Integration Tests (HTTP Transport, real server)

**File: `mcp-server/tests/integration/streamable-http.test.ts`** (Create)
```typescript
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe('Streamable HTTP Transport', () => {
  let server: ChildProcess;

  beforeAll(async () => {
    server = spawn('node', ['dist/index.js'], { env: { ...process.env, PORT: '9999' } });
    await waitForHealthy('http://localhost:9999/health');
  });

  test('initialize and list tools', async () => {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:9999/mcp'));
    const client = new Client({ name: "test", version: "1.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();
  });

  test('session management', async () => {
    // Initialize, get session ID, make requests, terminate
  });

  afterAll(() => server.kill());
});
```

**File: `mcp-server/tests/integration/oauth-flow.test.ts`** (Create)
- Full programmatic OAuth flow against running server
- DCR → authorize → callback simulation → token exchange → tool call

#### Layer 3: Protocol Compliance (MCP Validator)

**File: `mcp-server/tests/compliance/run-validator.sh`** (Create)
```bash
#!/bin/bash
# Run MCP Validator against our server
pip install mcp-testing 2>/dev/null
python -m mcp_testing.scripts.http_compliance_test \
  --server-url http://localhost:8081/mcp \
  --protocol-version 2025-06-18 \
  --output-dir reports/compliance/
```

#### Layer 4: Enable Banking Sandbox E2E

**File: `mcp-server/tests/e2e/enable-banking-sandbox.test.ts`** (Create)
- Runs against real Enable Banking sandbox API
- Tests: JWT auth → list ASPSPs → initiate auth → (simulated callback) → create session → get accounts → get transactions
- Gated by `ENABLE_SANDBOX=true` env var

### Success Criteria

#### Automated Verification
- [x] `npm test` runs all unit tests (Layer 1) — 37 tests pass, all tool handlers tested
- [x] `npm run test:integration` runs integration tests (Layer 2) — server lifecycle managed automatically
- [ ] `npm run test:compliance` runs MCP Validator — all checks pass for 2025-06-18
- [ ] `npm run test:e2e` runs sandbox tests (Layer 4) — requires Enable Banking credentials
- [ ] CI pipeline runs Layers 1-3 on every push
- [ ] CI pipeline runs Layer 4 on main branch with sandbox credentials

#### Manual Verification
- [ ] Test results are clear and actionable

### Dependencies
- Requires: Phase 2, 3, 4 (tests written alongside, but comprehensive suite assembled here)
- Blocks: Phase 6

---

## Phase 6: Docker & Deployment

### Changes

#### Update: `docker-compose.yml`
- **What**: Replace Python `mcp-server` service with new TypeScript multi-instance pattern
- **Replace**: Old `mcp-server` + `Dockerfile.mcp` → shared image, per-bank services
- **Remove**: worker, api, log-viewer, mcp-inspector (simplify — MCP server is self-contained)
- **Keep**: db (for future transaction storage), reverse-proxy, redis
- **Code sketch**:
  ```yaml
  # Shared build definition
  x-mcp-server: &mcp-server
    build:
      context: ./mcp-server
      dockerfile: Dockerfile
    volumes:
      - ./keys:/app/keys:ro
    environment: &mcp-env
      ENABLE_APP_ID: ${ENABLE_APP_ID}
      ENABLE_PRIVATE_KEY_PATH: /app/keys/enablebanking_private.pem
      ENABLE_API_BASE_URL: ${ENABLE_API_BASE_URL:-https://api.enablebanking.com}
    restart: unless-stopped
    user: "node"
    mem_limit: 256m
    cpus: '0.5'
    cap_drop: [ALL]
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:${PORT:-8081}/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Bank: Mock ASPSP (sandbox/dev)
  mcp-mock-bank:
    <<: *mcp-server
    environment:
      <<: *mcp-env
      PORT: "8081"
      ASPSP_NAME: MOCKASPSP_SANDBOX
      ASPSP_COUNTRY: FI
      EXTERNAL_URL: ${EXTERNAL_URL:-http://localhost:8081}
    ports: ["8081:8081"]
    volumes:
      - ./keys:/app/keys:ro
      - mcp_mock_data:/app/data

  # Bank: Revolut (example — add more as needed)
  # mcp-revolut:
  #   <<: *mcp-server
  #   environment:
  #     <<: *mcp-env
  #     PORT: "8082"
  #     ASPSP_NAME: Revolut
  #     ASPSP_COUNTRY: GB
  #     EXTERNAL_URL: https://mcp-revolut.example.com
  #   ports: ["8082:8082"]
  #   volumes:
  #     - ./keys:/app/keys:ro
  #     - mcp_revolut_data:/app/data
  ```

#### Update: `Caddyfile.prod`
- **What**: Route `/mcp`, `/.well-known/*`, `/authorize`, `/token`, `/register`, `/revoke`, `/auth/eb-callback` to mcp-server
- **Rationale**: Caddy handles TLS, MCP server handles everything else

#### Update: `.github/workflows/verify.yml`
- **What**: Update CI to build TypeScript, run Vitest, run compliance tests
- **Code sketch**:
  ```yaml
  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: '22' }
        - run: cd mcp-server && npm ci
        - run: cd mcp-server && npm run build
        - run: cd mcp-server && npm test
        - run: cd mcp-server && npm run test:integration
    compliance:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: '22' }
        - uses: actions/setup-python@v5
          with: { python-version: '3.12' }
        - run: pip install mcp-testing
        - run: cd mcp-server && npm ci && npm run build
        - run: cd mcp-server && node dist/index.js &
        - run: sleep 3 && python -m mcp_testing.scripts.http_compliance_test --output-dir reports/
  ```

### Success Criteria

#### Automated Verification
- [x] Docker image builds and runs successfully (standalone)
- [x] Claude Code connects to local MCP server (`claude mcp list` shows ✓ Connected)
- [x] Full MCP protocol flow verified: initialize → tools/list → tools/call
- [ ] `docker compose up -d` starts all services with new mcp-server (requires compose update)
- [ ] CI pipeline passes on push
- [ ] MCP server accessible via Caddy reverse proxy

#### Manual Verification
- [ ] Claude.ai can connect to deployed MCP server
- [ ] Full flow: Claude → OAuth → bank login → tool invocation → see transactions

### Dependencies
- Requires: Phase 1-5
- Blocks: nothing (final phase)

---

## Phase 7: Cleanup

### Changes

- **Remove** old Python source files: `src/mcp_*.py`, `src/simple_*.py`, `src/enable_banking*.py`, etc.
- **Remove** old Dockerfiles: `Dockerfile.mcp`, `Dockerfile.api`, `Dockerfile.test`
- **Remove** old test files that tested the Python implementation
- **Keep** `src/categorizer.py`, `src/projector.py`, `src/outlier_detector.py` — these contain business logic that can be ported to TypeScript later or called as microservices
- **Update** `CLAUDE.md` to reflect new architecture
- **Update** `requirements.txt` — only keep what's needed for remaining Python code

### Success Criteria

#### Automated Verification
- [ ] No broken imports or references to removed files
- [ ] All tests pass after cleanup
- [ ] Docker compose still works

### Dependencies
- Requires: Phase 6 (ensure new system works before removing old)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Claude.ai hardcodes OAuth paths relative to server URL (ignores metadata) | Confirmed | High | Use SDK's `mcpAuthRouter` which serves endpoints at expected paths. Known issue: anthropics/claude-ai-mcp#82 |
| Claude omits `scope` in DCR and `resource` param in auth requests | Confirmed | Medium | Apply sensible defaults when missing. Don't reject requests missing these optional params. |
| Enable Banking sandbox instability | Medium | Medium | Mock EB client for unit/integration tests; only hit sandbox in dedicated E2E tests. |
| Open DCR allows malicious client registration | Medium | Critical | Strict redirect_uri allowlist (Claude URLs only). Addressed in Phase 4 code. |
| Token leakage via DB compromise | Medium | High | Store token hashes (SHA-256), not plaintext. Addressed in session-store.ts. |
| Enable Banking session expiry during use | Medium | Medium | Tools check EB session validity; return clear error prompting re-auth. |
| Private key compromise via container escape | Low | Critical | Use Docker secrets instead of volume mounts for production. Per-bank key rotation limits blast radius. |
| Session store corruption/loss | Low | Medium | SQLite with WAL mode; users re-authorize easily (bank login again). |
| Breaking change in MCP spec | Low | Low | Pin SDK version; spec is stable at 2025-06-18. |

## Security Checklist (from security review)

Must be verified before any deployment:
- [ ] DCR redirect_uri allowlist enforced (only Claude callback URLs accepted)
- [ ] Tokens generated with `crypto.randomBytes(32)` (256-bit entropy)
- [ ] Auth codes are single-use, 60-second TTL, bound to client_id + redirect_uri
- [ ] Tokens stored as SHA-256 hashes in SQLite
- [ ] Token expiry checked on every request in auth middleware
- [ ] PKCE S256 verified on token exchange
- [ ] Origin header validated on `/mcp` endpoint
- [ ] Rate limiting on `/authorize`, `/token`, `/register`
- [ ] Audit logging for all OAuth events (no secrets in logs)
- [ ] No financial PII in application logs
- [ ] Private key loaded via Docker secrets (not env vars) in production
- [ ] `WWW-Authenticate` header set as HTTP header (not in JSON body)
- [ ] Stale pending_auths and expired sessions cleaned up periodically

## Rollback Strategy

The old Python code stays on `main` branch until Phase 6 is verified. If the rewrite fails:
1. Revert docker-compose.yml changes
2. Old system is immediately operational
3. New TypeScript code lives in `mcp-server/` directory — no conflict with old `src/`

## File Ownership Summary

| File/Directory | Phase | Change Type |
|---|---|---|
| `mcp-server/package.json` | 1 | Create |
| `mcp-server/tsconfig.json` | 1 | Create |
| `mcp-server/vitest.config.ts` | 1 | Create |
| `mcp-server/Dockerfile` | 1 | Create |
| `mcp-server/src/index.ts` | 1 | Create |
| `mcp-server/src/server.ts` | 2 | Create |
| `mcp-server/src/transport.ts` | 2 | Create |
| `mcp-server/src/tools/accounts.ts` | 2 | Create |
| `mcp-server/src/tools/transactions.ts` | 2 | Create |
| `mcp-server/src/enable-banking/client.ts` | 3 | Create |
| `mcp-server/src/enable-banking/session-store.ts` | 3 | Create |
| `mcp-server/src/auth/oauth-server.ts` | 4 | Create |
| `mcp-server/src/auth/client-registry.ts` | 4 | Create |
| `mcp-server/src/auth/middleware.ts` | 4 | Create |
| `mcp-server/src/auth/pkce.ts` | 4 | Create |
| `mcp-server/tests/unit/*.test.ts` | 5 | Create |
| `mcp-server/tests/integration/*.test.ts` | 5 | Create |
| `mcp-server/tests/compliance/run-validator.sh` | 5 | Create |
| `mcp-server/tests/e2e/*.test.ts` | 5 | Create |
| `docker-compose.yml` | 6 | Modify |
| `Caddyfile.prod` | 6 | Modify |
| `.github/workflows/verify.yml` | 6 | Modify |
| `src/mcp_*.py` (all) | 7 | Delete |
| `src/enable_banking*.py` | 7 | Delete |
| `src/simple_*.py` | 7 | Delete |
| `Dockerfile.mcp`, `Dockerfile.api`, `Dockerfile.test` | 7 | Delete |
