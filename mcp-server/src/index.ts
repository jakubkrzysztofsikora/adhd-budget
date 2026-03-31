import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createLogger } from './logger.js';
import { getConfig } from './config.js';
import { registerTools, type ToolContext } from './tools/index.js';
import { EnableBankingClient } from './enable-banking/client.js';
import { EnableBankingOAuthProvider } from './auth/oauth-provider.js';

const logger = createLogger();
const config = getConfig();

// Initialize Enable Banking client (if credentials available)
let ebClient: EnableBankingClient | null = null;
let oauthProvider: EnableBankingOAuthProvider | null = null;

if (config.enableAppId && config.enablePrivateKeyPath) {
  try {
    const privateKey = readFileSync(config.enablePrivateKeyPath, 'utf-8');
    ebClient = new EnableBankingClient(config.enableAppId, privateKey, config.enableApiBaseUrl);
    oauthProvider = new EnableBankingOAuthProvider({
      dataDir: config.dataDir,
      externalUrl: config.externalUrl,
      aspspName: config.aspspName,
      aspspCountry: config.aspspCountry,
      enableBankingClient: ebClient,
    });
    logger.info('Enable Banking OAuth provider initialized');
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize Enable Banking client — running without auth');
  }
}

// Create Express app with DNS rebinding protection
// Derive allowed hosts from EXTERNAL_URL + localhost for dev
const externalHostname = new URL(config.externalUrl).hostname;
const allowedHosts = ['localhost', '127.0.0.1', externalHostname];
const app = createMcpExpressApp({ host: config.host, allowedHosts });

app.use(express.json());

// Health endpoint (unauthenticated)
app.get('/health', async (_req, res) => {
  let ebApiReachable = false;
  let ebApiError = '';
  if (ebClient) {
    try {
      await ebClient.listAspsps('FI');
      ebApiReachable = true;
    } catch (err: unknown) {
      const e = err as Error & { cause?: Error };
      ebApiError = e.cause?.message || e.message || String(err);
    }
  }
  res.json({
    status: 'ok',
    bank: config.aspspName,
    country: config.aspspCountry,
    auth: oauthProvider ? 'oauth' : 'none',
    ebConfigured: !!ebClient,
    ebApiReachable,
    ebApiError: ebApiError || undefined,
    externalUrl: config.externalUrl,
  });
});

// Mount OAuth routes if provider is available
if (oauthProvider) {
  const issuerUrl = new URL(config.externalUrl);
  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    baseUrl: issuerUrl,
    scopesSupported: ['banking'],
    resourceName: `Enable Banking - ${config.aspspName}`,
  }));

  // Enable Banking callback (NOT part of mcpAuthRouter)
  app.get('/auth/eb-callback', async (req, res) => {
    const { code, state } = req.query;
    logger.info({ hasCode: !!code, hasState: !!state }, 'oauth.eb_callback.received');
    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      logger.warn({ query: req.query }, 'oauth.eb_callback.missing_params');
      res.status(400).send('Missing code or state parameter');
      return;
    }
    const result = await oauthProvider!.handleEbCallback(code, state);
    if ('error' in result) {
      logger.error({ error: result.error }, 'oauth.eb_callback.error');
      res.status(400).send(result.error);
      return;
    }
    logger.info({ redirectUrl: result.redirectUrl.substring(0, 80) }, 'oauth.eb_callback.redirecting');
    res.redirect(result.redirectUrl);
  });
}

// Session-mapped transports
const transports = new Map<string, StreamableHTTPServerTransport>();

function createServerForSession(authInfo?: AuthInfo): McpServer {
  const ctx: ToolContext = {
    getClient: () => ebClient,
    getAccountUids: () => (authInfo?.extra?.accountUids as string[]) ?? [],
    getSessionId: () => (authInfo?.extra?.ebSessionId as string) ?? null,
  };

  const server = new McpServer(
    { name: `enable-banking-${config.aspspName.toLowerCase()}`, version: '2.0.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server, ctx);
  return server;
}

// Bearer auth middleware (optional — only if OAuth provider is configured)
const authMiddleware = oauthProvider
  ? requireBearerAuth({
      verifier: oauthProvider,
      resourceMetadataUrl: `${config.externalUrl}/.well-known/oauth-protected-resource`,
    })
  : (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();

// POST /mcp
app.post('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    logger.info('New MCP session initializing');
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        logger.info({ sessionId: sid }, 'MCP session created');
        transports.set(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        logger.info({ sessionId: transport.sessionId }, 'MCP session closed');
        transports.delete(transport.sessionId);
      }
    };
    const server = createServerForSession(req.auth);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({ error: 'Bad request: missing session ID or not an initialize request' });
});

// GET /mcp — SSE
app.get('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

// DELETE /mcp — Session termination
app.delete('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

const port = config.port;
app.listen(port, config.host, () => {
  logger.info({ port, host: config.host, bank: config.aspspName, country: config.aspspCountry, auth: oauthProvider ? 'oauth' : 'none' }, 'MCP server started');
});
