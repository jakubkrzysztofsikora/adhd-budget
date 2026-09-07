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
import { getConfig, SUPPORTED_BANKS } from './config.js';
import { registerTools, type ToolContext } from './tools/index.js';
import { EnableBankingClient } from './enable-banking/client.js';
import { EnableBankingOAuthProvider } from './auth/oauth-provider.js';
import { SessionStore } from './enable-banking/session-store.js';
import { ImprovementPlanStore } from './digest/plan-store.js';
import { EmailSender } from './digest/email-sender.js';
import { DigestService } from './digest/digest-service.js';
import { DigestScheduler } from './digest/scheduler.js';

const logger = createLogger();
const config = getConfig();

// Initialize session store & plan store
const sessionStore = new SessionStore(`${config.dataDir}/sessions.db`);
const planStore = new ImprovementPlanStore(sessionStore.getDb());
const emailSender = new EmailSender({
  secretKey: config.scwSecretKey,
  projectId: config.scwProjectId,
  senderEmail: config.emailSender,
});

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
      staticUsers: config.oauthUsers,
      defaultUser: config.defaultUser,
    });
    logger.info({ users: Array.from(config.oauthUsers.keys()) }, 'OAuth provider initialized with static users');
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize Enable Banking client — running without auth');
  }
}

// Initialize Daily Digest Service & Scheduler
const digestService = new DigestService(sessionStore, planStore, emailSender, config, ebClient || undefined);
const digestScheduler = new DigestScheduler(digestService, planStore, config.digestCronHour);
if (process.env.NODE_ENV !== 'test') {
  digestScheduler.start();
}

// Create Express app with DNS rebinding protection for loopback interfaces
const externalHostname = new URL(config.externalUrl).hostname;
const allowedHosts = config.host === '0.0.0.0'
  ? undefined
  : ['localhost', '127.0.0.1', 'host.docker.internal', externalHostname];
const app = createMcpExpressApp({ host: config.host, allowedHosts });
app.set('trust proxy', 1);


app.use(express.json());
app.use(express.urlencoded({ extended: false }));


// In-memory pending connects for /connect/start -> /auth/eb-callback
const pendingConnects = new Map<string, { bankKey: string; aspspName: string; aspspCountry: string; ownerName: string; createdAt: number }>();

// Health endpoint (unauthenticated)
app.get('/health', async (_req, res) => {
  let ebApiReachable = false;
  let ebApiError = '';
  if (ebClient) {
    try {
      await ebClient.listAspsps('PL');
      ebApiReachable = true;
    } catch (err: unknown) {
      const e = err as Error & { cause?: Error };
      ebApiError = e.cause?.message || e.message || String(err);
    }
  }

  const connectedBanks = sessionStore.getAllBankConnections();
  const manualAccounts = sessionStore.getAllManualAccounts();

  res.json({
    status: 'ok',
    version: '2.1.0',
    auth: oauthProvider ? 'oauth' : 'none',
    ebConfigured: !!ebClient,
    ebApiReachable,
    ebApiError: ebApiError || undefined,
    externalUrl: config.externalUrl,
    connected_banks: connectedBanks.map(b => ({
      id: b.id,
      bank: b.aspsp_name,
      key: b.bank_key,
      owner: b.owner_name,
      accounts: b.account_uids.length,
      valid_until: b.valid_until,
    })),
    manual_accounts: manualAccounts.map(m => ({
      id: m.id,
      name: m.name,
      type: m.type,
      balance: m.balance,
      currency: m.currency,
      owner: m.owner_name,
    })),
  });
});

// ==========================================
// Bank Connection Web Dashboard (/connect)
// ==========================================

app.get('/connect', (req, res) => {
  const selectedOwner = ((req.query.owner as string) || '').trim();
  const defaultOwner = selectedOwner || 'Jakub';
  const connected = sessionStore.getAllBankConnections();
  const manualAccounts = sessionStore.getAllManualAccounts();
  const statusMsg = req.query.status as string | undefined;
  const bankParam = req.query.bank as string | undefined;
  const errorMsg = req.query.message as string | undefined;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ADHD Budget Assistant - Bank Hub</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #3b82f6;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --border: #334155;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem 1rem;
      display: flex;
      justify-content: center;
    }
    .container {
      max-width: 800px;
      width: 100%;
    }
    header {
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1rem;
    }
    h1 { margin: 0 0 0.5rem 0; font-size: 1.8rem; }
    p.sub { color: var(--muted); margin: 0; font-size: 0.95rem; }
    .alert {
      padding: 1rem;
      border-radius: 8px;
      margin-bottom: 1.5rem;
      font-size: 0.9rem;
    }
    .alert-success { background: rgba(16, 185, 129, 0.15); border: 1px solid var(--success); color: #34d399; }
    .alert-error { background: rgba(239, 68, 68, 0.15); border: 1px solid var(--danger); color: #f87171; }
    .card-list { display: flex; flex-direction: column; gap: 1rem; margin-bottom: 2.5rem; }
    .bank-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .bank-info h3 { margin: 0 0 0.25rem 0; font-size: 1.1rem; }
    .bank-info .meta { font-size: 0.85rem; color: var(--muted); }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-right: 0.5rem;
    }
    .badge-active { background: rgba(16, 185, 129, 0.2); color: var(--success); }
    .badge-none { background: rgba(148, 163, 184, 0.2); color: var(--muted); }
    .btn {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 0.6rem 1.2rem;
      border-radius: 6px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      font-size: 0.9rem;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }
    .btn:hover { opacity: 0.9; }
    .btn-secondary { background: #475569; }
    .btn-active-pill { background: #2563eb; border: 1px solid #60a5fa; color: #fff; font-weight: 600; }
    .btn-danger { background: var(--danger); }
    .docs {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.5rem;
    }
    .docs h2 { margin-top: 0; font-size: 1.2rem; }
    pre {
      background: #090d16;
      padding: 0.75rem;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 0.85rem;
      color: #38bdf8;
    }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  </style>
  <script>
    function setMember(name) {
      document.querySelectorAll('input[name="owner"], input[name="owner_name"]').forEach(function(el) {
        el.value = name;
      });
      document.querySelectorAll('.owner-pill').forEach(function(btn) {
        if (btn.getAttribute('data-owner') === name) {
          btn.classList.add('btn-active-pill');
          btn.classList.remove('btn-secondary');
        } else {
          btn.classList.remove('btn-active-pill');
          btn.classList.add('btn-secondary');
        }
      });
      var badges = document.querySelectorAll('.active-owner-display');
      badges.forEach(function(b) { b.innerText = name; });
    }
  </script>
</head>
<body>
  <div class="container">
    <header>
      <h1>🏦 ADHD Budget — Polish Bank Hub</h1>
      <p class="sub">Connect and manage Polish bank accounts across multiple household members safely for AI assistants.</p>
    </header>

    ${statusMsg === 'connected' ? `<div class="alert alert-success">✅ Successfully connected <strong>${bankParam || 'bank'}</strong>!</div>` : ''}
    ${statusMsg === 'disconnected' ? `<div class="alert alert-success">Disconnected <strong>${bankParam || 'bank'}</strong>.</div>` : ''}
    ${statusMsg === 'manual_saved' ? `<div class="alert alert-success">✅ Zapisano aktywo: <strong>${bankParam || 'Aktywo'}</strong>!</div>` : ''}
    ${statusMsg === 'manual_updated' ? `<div class="alert alert-success">✅ Zaktualizowano saldo dla: <strong>${bankParam || 'Aktywo'}</strong>!</div>` : ''}
    ${statusMsg === 'manual_deleted' ? `<div class="alert alert-success">🗑️ Usunięto aktywo: <strong>${bankParam || 'Aktywo'}</strong>.</div>` : ''}
    ${statusMsg === 'error' ? `<div class="alert alert-error">❌ Error: ${errorMsg || 'Operacja nie powiodła się'}</div>` : ''}

    <div style="background: rgba(30, 41, 59, 0.8); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 2rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem;">
      <div style="display: flex; align-items: center; gap: 0.75rem;">
        <span style="font-size: 0.9rem; font-weight: 600; color: var(--muted);">Household Profile:</span>
        <div style="display: flex; gap: 0.5rem;">
          <button type="button" onclick="setMember('Jakub')" data-owner="Jakub" class="btn owner-pill ${defaultOwner.toLowerCase() === 'jakub' ? 'btn-active-pill' : 'btn-secondary'}" style="padding: 0.4rem 0.9rem; font-size: 0.85rem;">👤 Jakub</button>
          <button type="button" onclick="setMember('Arleta')" data-owner="Arleta" class="btn owner-pill ${defaultOwner.toLowerCase() === 'arleta' ? 'btn-active-pill' : 'btn-secondary'}" style="padding: 0.4rem 0.9rem; font-size: 0.85rem;">👤 Arleta</button>
        </div>
      </div>
      <div style="font-size: 0.85rem; color: #94a3b8;">
        Connecting for: <strong class="active-owner-display" style="color: #60a5fa; font-size: 0.95rem;">${defaultOwner}</strong>
      </div>
    </div>

    <h2 style="font-size: 1.2rem; margin: 0 0 1rem 0;">Connected Bank Accounts</h2>
    <div class="card-list">
      ${connected.length > 0 ? connected.map(conn => {
        const daysLeft = Math.round((new Date(conn.valid_until).getTime() - Date.now()) / (24 * 3600 * 1000));
        return `
        <div class="bank-card">
          <div class="bank-info">
            <h3 style="display: flex; align-items: center; gap: 0.5rem;">
              ${conn.aspsp_name}
              <span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa;">👤 ${conn.owner_name}</span>
            </h3>
            <div class="meta">
              <span class="badge badge-active">Active (${daysLeft} days left)</span> ${conn.account_uids.length} account(s) synced
            </div>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            <a href="/connect/start?bank=${conn.bank_key}&owner=${encodeURIComponent(conn.owner_name)}" class="btn btn-secondary">Refresh</a>
            <a href="/connect/disconnect?id=${encodeURIComponent(conn.id)}" class="btn btn-danger" onclick="return confirm('Disconnect ${conn.aspsp_name} (${conn.owner_name})?')">Disconnect</a>
          </div>
        </div>
        `;
      }).join('') : `
        <div style="background: var(--card); border: 1px dashed var(--border); border-radius: 10px; padding: 1.5rem; text-align: center; color: var(--muted);">
          No bank accounts connected yet. Connect an account below!
        </div>
      `}
    </div>

    <div style="margin-bottom: 2rem; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem;">
      <h3 style="margin-top: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem;">
        <span>➕</span> Connect a Bank Account (via Bank SCA Login)
      </h3>
      <p style="color: var(--muted); font-size: 0.85rem; margin-bottom: 1rem;">
        Select a bank. Currently connecting as <strong class="active-owner-display" style="color: #60a5fa;">${defaultOwner}</strong> (switch above if needed). Accounts from the same bank for Jakub and Arleta are stored separately and will never overwrite each other:
      </p>
      <form action="/connect/start" method="GET" style="display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center;">
        <select 
          name="bank" 
          required 
          style="flex: 1; min-width: 200px; padding: 0.6rem 0.9rem; border-radius: 6px; border: 1px solid var(--border); background: #090d16; color: var(--text); font-size: 0.85rem;"
        >
          ${SUPPORTED_BANKS.map(b => `<option value="${b.key}">${b.title}</option>`).join('')}
        </select>
        <input 
          type="text" 
          name="owner" 
          placeholder="Owner name (e.g. Jakub, Arleta)" 
          value="${defaultOwner}" 
          required 
          style="width: 200px; padding: 0.6rem 0.9rem; border-radius: 6px; border: 1px solid var(--border); background: #090d16; color: var(--text); font-size: 0.85rem;"
        />
        <button type="submit" class="btn" style="white-space: nowrap;">Connect via Bank &rarr;</button>
      </form>
    </div>

    <div style="margin-bottom: 2rem; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem;">
      <h3 style="margin-top: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem;">
        <span>⚡</span> Direct Import via Enable Banking Session ID
      </h3>
      <p style="color: var(--muted); font-size: 0.85rem; margin-bottom: 1rem;">
        Already linked your accounts in the <a href="https://enablebanking.com/cp/" target="_blank" style="color: var(--primary); text-decoration: underline;">Enable Banking Control Panel</a>? Paste the <code>session_id</code> and specify the account owner:
      </p>
      <form action="/connect/import-session" method="POST" style="display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center;">
        <input 
          type="text" 
          name="session_id" 
          placeholder="Paste session_id (e.g. 1a2b3c4d-5e6f-...)" 
          required 
          style="flex: 1; min-width: 260px; padding: 0.6rem 0.9rem; border-radius: 6px; border: 1px solid var(--border); background: #090d16; color: var(--text); font-size: 0.85rem; font-family: monospace;"
        />
        <input 
          type="text" 
          name="owner_name" 
          placeholder="Owner name (e.g. Jakub, Arleta)" 
          value="${defaultOwner}" 
          required 
          style="width: 200px; padding: 0.6rem 0.9rem; border-radius: 6px; border: 1px solid var(--border); background: #090d16; color: var(--text); font-size: 0.85rem;"
        />
        <button type="submit" class="btn" style="white-space: nowrap;">Import Session</button>
      </form>
    </div>

    <h2 style="font-size: 1.2rem; margin: 2rem 0 1rem 0;">💰 Offline & Manual Wealth Assets</h2>
    <p style="color: var(--muted); font-size: 0.85rem; margin-bottom: 1rem;">
      Track assets that cannot be synced automatically via Open Banking (Revolut Savings Vaults, Crypto Wallets, XTB Stocks, Physical Gold/Silver). Update their values here anytime:
    </p>
    <div class="card-list">
      ${manualAccounts.length > 0 ? manualAccounts.map(acc => {
        const typeLabels: Record<string, string> = {
          savings_vault: '🏦 Sejf oszczędnościowy',
          crypto: '🪙 Kryptowaluta',
          investments: '📈 Inwestycje / XTB',
          physical_vault: '🏆 Sejf domowy / Kruszce',
          other: '📦 Inne aktywo'
        };
        const typeLabel = typeLabels[acc.type] || acc.type;
        return `
        <div class="bank-card" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
          <div class="bank-info" style="min-width: 240px;">
            <h3 style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
              ${acc.name}
              <span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa;">👤 ${acc.owner_name}</span>
            </h3>
            <div class="meta" style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
              <span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399;">${typeLabel}</span>
              ${acc.institution ? `<span style="color: var(--muted); font-size: 0.8rem;">(${acc.institution})</span>` : ''}
              ${acc.notes ? `<span style="color: #64748b; font-size: 0.75rem; font-style: italic;">${acc.notes}</span>` : ''}
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
            <form action="/connect/manual-account/update" method="POST" style="display: flex; align-items: center; gap: 0.5rem; margin: 0;">
              <input type="hidden" name="id" value="${acc.id}" />
              <input 
                type="number" 
                step="any" 
                name="balance" 
                value="${acc.balance}" 
                required 
                style="width: 120px; padding: 0.5rem 0.75rem; border-radius: 6px; border: 1px solid var(--border); background: #090d16; color: #34d399; font-weight: bold; font-size: 0.9rem;"
              />
              <span style="font-weight: 600; font-size: 0.85rem; color: #94a3b8; min-width: 35px;">${acc.currency}</span>
              <button type="submit" class="btn btn-secondary" style="padding: 0.5rem 0.8rem; font-size: 0.85rem;">Save</button>
            </form>
            <a href="/connect/manual-account/delete?id=${encodeURIComponent(acc.id)}" class="btn btn-danger" style="padding: 0.5rem 0.8rem; font-size: 0.85rem;" onclick="return confirm('Delete ${acc.name}?')">Delete</a>
          </div>
        </div>
        `;
      }).join('') : `
        <div style="background: var(--card); border: 1px dashed var(--border); border-radius: 10px; padding: 1.5rem; text-align: center; color: var(--muted);">
          No manual accounts added yet. Add one below!
        </div>
      `}
    </div>

    <div style="margin-bottom: 2rem; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem;">
      <h3 style="margin-top: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem;">
        <span>🪙</span> Add Manual / Offline Asset
      </h3>
      <p style="color: var(--muted); font-size: 0.85rem; margin-bottom: 1rem;">
        Add assets that cannot be synced automatically via Open Banking:
      </p>
      <form action="/connect/manual-account" method="POST" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; align-items: end;">
        <div>
          <label style="display: block; font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem;">Asset Name</label>
          <input type="text" name="name" placeholder="e.g. Revolut Vault PLN, Treasury Bonds" required style="width: 100%; box-sizing: border-box; padding: 0.6rem; border-radius: 6px; border: 1px solid var(--border); background: #090d16; color: var(--text); font-size: 0.85rem;" />
        </div>
        <div>
          <label style="display: block; font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem;">Category</label>
          <select name="type" required style="width: 100%; box-sizing: border-box; padding: 0.6rem; border-radius: 6px; border: 1px solid var(--border); background: #090d16; color: var(--text); font-size: 0.85rem;">
            <option value="savings_vault">Savings Vault (Sejf / Oszczędności)</option>
            <option value="crypto">Crypto Wallet (Kryptowaluta)</option>
            <option value="investments">Investments / Stocks (XTB, Makler)</option>
            <option value="physical_vault">Physical Vault (Złoto / Srebro / Gotówka)</option>
            <option value="other">Other Asset</option>
          </select>
        </div>
        <div>
          <label style="display: block; font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem;">Balance / Amount</label>
          <input type="number" step="any" name="balance" placeholder="0.00" required style="width: 100%; box-sizing: border-box; padding: 0.6rem; border-radius: 6px; border: 1px solid var(--border); background: #090d16; color: var(--text); font-size: 0.85rem;" />
        </div>
        <div>
          <label style="display: block; font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem;">Currency</label>
          <input type="text" name="currency" placeholder="PLN / EUR / BTC / ETH" value="PLN" required style="width: 100%; box-sizing: border-box; padding: 0.6rem; border-radius: 6px; border: 1px solid var(--border); background: #090d16; color: var(--text); font-size: 0.85rem;" />
        </div>
        <div>
          <label style="display: block; font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem;">Owner</label>
          <input type="text" name="owner_name" placeholder="e.g. Jakub, Arleta" value="Jakub" required style="width: 100%; box-sizing: border-box; padding: 0.6rem; border-radius: 6px; border: 1px solid var(--border); background: #090d16; color: var(--text); font-size: 0.85rem;" />
        </div>
        <div>
          <label style="display: block; font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem;">Institution / Location</label>
          <input type="text" name="institution" placeholder="e.g. Revolut, XTB, Home Safe" style="width: 100%; box-sizing: border-box; padding: 0.6rem; border-radius: 6px; border: 1px solid var(--border); background: #090d16; color: var(--text); font-size: 0.85rem;" />
        </div>
        <div style="grid-column: 1 / -1; display: flex; gap: 0.75rem;">
          <input type="text" name="notes" placeholder="Notes (optional, e.g. 0.069 BTC cold storage)" style="flex: 1; padding: 0.6rem; border-radius: 6px; border: 1px solid var(--border); background: #090d16; color: var(--text); font-size: 0.85rem;" />
          <button type="submit" class="btn" style="white-space: nowrap;">+ Add Asset</button>
        </div>
      </form>
    </div>

    <div class="docs">
      <h2>🤖 Connect to Your AI Clients</h2>
      <p style="color:var(--muted);font-size:0.9rem;">Once your banks are linked above, connect any of these AI clients to access your unified finances:</p>
      
      <h3>1. Claude Code CLI</h3>
      <pre><code>claude mcp add --transport http adhd-budget ${config.externalUrl}/mcp --header "Authorization: Bearer &lt;YOUR_MCP_TOKEN&gt;"</code></pre>

      <h3>2. Kimi Desktop / Odysseus Web (HTTP API)</h3>
      <p style="font-size:0.85rem;color:var(--muted);">Configure Streamable HTTP transport with Bearer token:</p>
      <pre><code>URL: ${config.externalUrl}/mcp
Header: Authorization: Bearer &lt;YOUR_MCP_TOKEN&gt;</code></pre>


      <h3>3. Claude AI (Web & Desktop)</h3>
      <p style="font-size:0.85rem;color:var(--muted);">Add Custom Remote MCP in Claude Settings &rarr; Integrations:</p>
      <pre><code>URL: ${config.externalUrl}/mcp</code></pre>
      <p style="font-size:0.85rem;color:var(--muted);">When prompted in the popup window, log in with username: <code>${config.defaultUser}</code></p>

    </div>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Start bank SCA connection
app.get('/connect/start', async (req, res) => {
  const bankKey = req.query.bank as string;
  const ownerName = (req.query.owner as string || 'Jakub').trim() || 'Jakub';
  if (!ebClient) {
    res.status(500).send('Enable Banking client not initialized. Check server credentials.');
    return;
  }

  const bankDef = SUPPORTED_BANKS.find(b => b.key === bankKey);
  if (!bankDef) {
    res.status(400).send(`Unknown bank: ${bankKey}. Supported: ${SUPPORTED_BANKS.map(b => b.key).join(', ')}`);
    return;
  }

  try {
    const ebState = `connect_${bankDef.key}_${randomUUID()}`;
    const callbackUrl = `${config.externalUrl}/auth/eb-callback`;

    const pendingData = {
      bankKey: bankDef.key,
      aspspName: bankDef.name,
      aspspCountry: bankDef.country,
      ownerName,
    };
    sessionStore.savePendingConnect(ebState, pendingData);
    pendingConnects.set(ebState, {
      ...pendingData,
      createdAt: Date.now(),
    });

    const ebResponse = await ebClient.initiateAuth(
      bankDef.name,
      bankDef.country,
      callbackUrl,
      ebState,
      'personal',
    );

    logger.info({ bank: bankDef.name, owner: ownerName, redirect: ebResponse.url }, 'connect_start_redirecting_to_bank');
    res.redirect(ebResponse.url);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg, bank: bankKey, owner: ownerName }, 'connect_start_failed');
    res.redirect(`/connect?status=error&message=${encodeURIComponent(errMsg)}`);
  }
});

// Disconnect bank
app.get('/connect/disconnect', (req, res) => {
  const id = req.query.id as string | undefined;
  const bankKey = req.query.bank as string | undefined;
  const target = id || bankKey;
  if (target) {
    sessionStore.deleteBankConnection(target);
  }
  res.redirect(`/connect?status=disconnected&bank=${encodeURIComponent(target || '')}`);
});

function matchBankKey(aspspName: string): string {
  const normalized = aspspName.toLowerCase();
  for (const bank of SUPPORTED_BANKS) {
    if (normalized.includes(bank.key.replace('_', ' ')) || 
        normalized.includes(bank.name.toLowerCase()) || 
        bank.name.toLowerCase().includes(normalized)) {
      return bank.key;
    }
  }
  if (normalized.includes('pko')) return 'pko_bp';
  if (normalized.includes('nest')) return 'nest_bank';
  if (normalized.includes('revolut')) return 'revolut';
  return normalized.replace(/[^a-z0-9]/g, '_').slice(0, 20);
}

// Direct import of existing session ID from Enable Banking Control Panel
app.post('/connect/import-session', async (req, res) => {
  const sessionId = (req.body.session_id as string || '').trim();
  const ownerName = (req.body.owner_name as string || 'Jakub').trim() || 'Jakub';
  if (!sessionId) {
    res.redirect('/connect?status=error&message=Missing+session_id');
    return;
  }
  if (!ebClient) {
    res.redirect('/connect?status=error&message=Enable+Banking+credentials+not+configured');
    return;
  }

  try {
    const fullSession = await ebClient.getSession(sessionId);
    const aspspName = fullSession.aspsp?.name || 'Unknown Bank';
    const aspspCountry = fullSession.aspsp?.country || 'PL';
    const bankKey = matchBankKey(aspspName);
    const accounts = fullSession.accounts || [];
    const accountUids = accounts.map((a: unknown) => typeof a === 'string' ? a : ((a as { uid?: string; account_id?: string })?.uid || (a as { uid?: string; account_id?: string })?.account_id || String(a)));

    sessionStore.saveBankConnection({
      id: `${bankKey}_${ownerName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      bank_key: bankKey,
      owner_name: ownerName,
      aspsp_name: aspspName,
      aspsp_country: aspspCountry,
      session_id: fullSession.session_id,
      account_uids: accountUids,
      accounts_data: accounts,
      valid_until: fullSession.valid_until || new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
    });

    logger.info({ bank: aspspName, owner: ownerName, sessionId, accounts: accountUids.length }, 'session_imported_successfully');
    res.redirect(`/connect?status=connected&bank=${encodeURIComponent(`${aspspName} (${ownerName})`)}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg, sessionId }, 'session_import_failed');
    res.redirect(`/connect?status=error&message=${encodeURIComponent(`Import failed: ${errMsg}`)}`);
  }
});

// Manual & Offline Assets routes
app.post('/connect/manual-account', (req, res) => {
  const id = (req.body.id as string || '').trim() || `manual-${Date.now()}`;
  const name = (req.body.name as string || '').trim();
  const type = (req.body.type as 'savings_vault' | 'crypto' | 'investments' | 'physical_vault' | 'other') || 'savings_vault';
  const balance = parseFloat(req.body.balance) || 0;
  const currency = (req.body.currency as string || 'PLN').trim().toUpperCase();
  const ownerName = (req.body.owner_name as string || 'Jakub').trim() || 'Jakub';
  const institution = (req.body.institution as string || '').trim();
  const notes = (req.body.notes as string || '').trim();

  if (!name) {
    res.redirect('/connect?status=error&message=Asset+name+is+required');
    return;
  }

  sessionStore.saveManualAccount({
    id,
    name,
    type,
    balance,
    currency,
    owner_name: ownerName,
    institution,
    notes,
  });

  logger.info({ id, name, type, balance, currency, ownerName }, 'manual_account_saved');
  res.redirect(`/connect?status=manual_saved&bank=${encodeURIComponent(name)}`);
});

app.post('/connect/manual-account/update', (req, res) => {
  const id = (req.body.id as string || '').trim();
  const balance = parseFloat(req.body.balance);

  if (!id || isNaN(balance)) {
    res.redirect('/connect?status=error&message=Invalid+balance+or+id');
    return;
  }

  const existing = sessionStore.getManualAccount(id);
  sessionStore.updateManualAccountBalance(id, balance);

  logger.info({ id, balance, name: existing?.name }, 'manual_account_balance_updated');
  res.redirect(`/connect?status=manual_updated&bank=${encodeURIComponent(existing?.name || id)}`);
});

app.get('/connect/manual-account/delete', (req, res) => {
  const id = (req.query.id as string || '').trim();
  if (id) {
    const existing = sessionStore.getManualAccount(id);
    sessionStore.deleteManualAccount(id);
    logger.info({ id, name: existing?.name }, 'manual_account_deleted');
    res.redirect(`/connect?status=manual_deleted&bank=${encodeURIComponent(existing?.name || id)}`);
    return;
  }
  res.redirect('/connect');
});


// Mount OAuth routes if provider is available
if (oauthProvider) {
  const issuerUrl = new URL(config.externalUrl);
  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    baseUrl: issuerUrl,
    scopesSupported: ['banking'],
    resourceName: `ADHD Budget Gateway`,
  }));

  // Enable Banking callback (handles both /connect/start and OAuth flow)
  app.get('/auth/eb-callback', async (req, res) => {
    const { code, state, error: ebError } = req.query;
    if (ebError) {
      res.redirect(`/connect?status=error&message=${encodeURIComponent(`Bank error: ${ebError}`)}`);
      return;
    }
    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      res.status(400).send('Missing code or state parameter');
      return;
    }

    // Check if this was initiated by /connect/start
    if (state.startsWith('connect_')) {
      const pending = sessionStore.getPendingConnect(state) || pendingConnects.get(state);
      if (!pending) {
        res.redirect(`/connect?status=error&message=${encodeURIComponent('Expired bank connection attempt')}`);
        return;
      }
      sessionStore.deletePendingConnect(state);
      pendingConnects.delete(state);

      try {
        const session = await ebClient!.createSession(code);
        const fullSession = await ebClient!.getSession(session.session_id);
        const accounts = fullSession.accounts || [];
        const accountUids = accounts.map((a: unknown) => typeof a === 'string' ? a : ((a as { uid?: string; account_id?: string })?.uid || (a as { uid?: string; account_id?: string })?.account_id || String(a)));

        sessionStore.saveBankConnection({
          id: `${pending.bankKey}_${pending.ownerName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          bank_key: pending.bankKey,
          owner_name: pending.ownerName,
          aspsp_name: fullSession.aspsp?.name || pending.aspspName,
          aspsp_country: fullSession.aspsp?.country || pending.aspspCountry,
          session_id: session.session_id,
          account_uids: accountUids,
          accounts_data: fullSession.accounts || [],
          valid_until: fullSession.valid_until || new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
        });

        logger.info({ bank: pending.aspspName, owner: pending.ownerName, accounts: accountUids.length }, 'bank_connected_successfully');
        res.redirect(`/connect?status=connected&bank=${encodeURIComponent(`${pending.aspspName} (${pending.ownerName})`)}`);
        return;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err: errMsg }, 'bank_session_exchange_failed');
        res.redirect(`/connect?status=error&message=${encodeURIComponent(errMsg)}`);
        return;
      }
    }

    // Otherwise, handle as Claude OAuth handshake
    const result = await oauthProvider!.handleEbCallback(code, state);
    if ('error' in result) {
      res.status(400).send(result.error);
      return;
    }
    res.redirect(result.redirectUrl);
  });
}

// Session-mapped transports
const transports = new Map<string, StreamableHTTPServerTransport>();

function createServerForSession(authInfo?: AuthInfo): McpServer {
  const ctx: ToolContext = {
    getClient: () => ebClient,
    getAccountUids: () => {
      const explicit = (authInfo?.extra?.accountUids as string[]) ?? [];
      if (explicit.length > 0 && !explicit.includes('*')) {
        return explicit;
      }
      return sessionStore.getAllBankConnections().flatMap(b => b.account_uids);
    },
    getSessionId: () => (authInfo?.extra?.ebSessionId as string) ?? null,
    getSessionStore: () => sessionStore,
  };

  const server = new McpServer(
    { name: 'adhd-budget-gateway', version: '2.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server, ctx);
  return server;
}

// Dual Auth Middleware (Bearer token for CLI/Desktop/API + OAuth for Claude Web)
const rawOAuthMiddleware = oauthProvider
  ? requireBearerAuth({
      verifier: oauthProvider,
      resourceMetadataUrl: `${config.externalUrl}/.well-known/oauth-protected-resource`,
    })
  : (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();

const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  if (config.mcpToken && authHeader === `Bearer ${config.mcpToken}`) {
    // Authenticated via static Bearer token (Claude Code, Kimi, Odysseus API mode)
    (req as express.Request & { auth: AuthInfo }).auth = {
      token: config.mcpToken,
      clientId: 'bearer-client',
      scopes: ['banking'],
      extra: { staticAuth: true, userId: config.defaultUser },
    };
    return next();
  }

  return rawOAuthMiddleware(req, res, next);
};


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

// ==========================================
// Daily Digest & Step-by-Step Plan Routes
// ==========================================

// Trigger daily digest (supports ?dry_run=true and ?date=YYYY-MM-DD)
app.post('/cron/daily-digest', authMiddleware, async (req, res) => {
  const dryRun = req.query.dry_run === 'true';
  const forceDate = req.query.date as string | undefined;

  try {
    const result = await digestService.runDailyDigest({ dryRun, forceDate });
    res.json({
      status: 'ok',
      dryRun,
      subject: result.formatted.subject,
      primaryAction: result.formatted.primaryAction,
      emailResult: result.emailResult,
      analysis: {
        date: result.analysis.date,
        totalSpentTodayPln: result.analysis.totalSpentTodayPln,
        harmfulTransactionsCount: result.analysis.harmfulTransactions.length,
        upcomingWeekEstimatedPln: result.analysis.totalUpcomingWeekPln,
        liquidBalancePln: result.analysis.liquidBalancePln,
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg }, 'cron_daily_digest_failed');
    res.status(500).json({ status: 'error', message: errMsg });
  }
});

// Preview daily digest without sending (supports ?format=html and ?date=YYYY-MM-DD)
app.get('/cron/daily-digest/preview', authMiddleware, async (req, res) => {
  const forceDate = req.query.date as string | undefined;

  try {
    const result = await digestService.runDailyDigest({ dryRun: true, forceDate });
    if (req.query.format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(result.formatted.html);
      return;
    }

    res.json({
      subject: result.formatted.subject,
      primaryAction: result.formatted.primaryAction,
      text: result.formatted.text,
      analysis: result.analysis,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ status: 'error', message: errMsg });
  }
});

// Get current improvement plan memory state
app.get('/cron/daily-digest/plan', authMiddleware, (_req, res) => {
  const state = planStore.getPlanState();
  res.json(state);
});

const port = config.port;
app.listen(port, config.host, () => {
  logger.info({ port, host: config.host, auth: oauthProvider ? 'dual (oauth + bearer)' : 'none' }, 'ADHD Budget Gateway started');
});
