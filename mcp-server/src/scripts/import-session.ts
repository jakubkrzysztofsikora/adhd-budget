import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, SUPPORTED_BANKS } from '../config.js';
import { EnableBankingClient } from '../enable-banking/client.js';
import { SessionStore } from '../enable-banking/session-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

async function main() {
  const sessionIds = process.argv.slice(2);
  if (sessionIds.length === 0) {
    console.log(`
Usage:
  npm run import-session <session_id> [session_id_2...]

Example:
  npm run import-session a1b2c3d4-e5f6-7890-abcd-ef1234567890

Where to find session IDs:
  In Enable Banking Control Panel (https://enablebanking.com/cp/):
  Go to Applications -> ADHD budget -> Request Logs -> Look for POST /sessions responses.
`);
    process.exit(1);
  }

  const config = getConfig();

  let keyPath = config.enablePrivateKeyPath;
  if (!existsSync(keyPath)) {
    const altPath = resolve(__dirname, '../../../keys/enablebanking_private.pem');
    if (existsSync(altPath)) {
      keyPath = altPath;
    }
  }

  if (!config.enableAppId || !existsSync(keyPath)) {
    console.error(`❌ Missing Enable Banking credentials. Check ENABLE_APP_ID and ENABLE_PRIVATE_KEY_PATH.`);
    process.exit(1);
  }

  const privateKey = readFileSync(keyPath, 'utf-8');
  const ebClient = new EnableBankingClient(config.enableAppId, privateKey, config.enableApiBaseUrl);
  const sessionStore = new SessionStore(`${config.dataDir}/sessions.db`);

  console.log(`\n🔍 Connecting to Enable Banking API (${config.enableApiBaseUrl})...\n`);

  for (const sessionId of sessionIds) {
    try {
      console.log(`📡 Fetching session details for: ${sessionId}`);
      const fullSession = await ebClient.getSession(sessionId);

      const aspspName = fullSession.aspsp?.name || 'Unknown Bank';
      const aspspCountry = fullSession.aspsp?.country || 'PL';
      const bankKey = matchBankKey(aspspName);
      const accounts = fullSession.accounts || [];
      const accountUids = accounts.map(a => a.uid);

      console.log(`   Bank: ${aspspName} (${aspspCountry})`);
      console.log(`   Key:  ${bankKey}`);
      console.log(`   Valid Until: ${fullSession.valid_until || 'N/A'}`);
      console.log(`   Accounts (${accounts.length}):`);

      for (const acc of accounts) {
        const iban = (acc.account_id as { iban?: string })?.iban || acc.uid;
        console.log(`     - Account UID: ${acc.uid} (${iban})`);

        try {
          const balances = await ebClient.getBalances(acc.uid);
          for (const b of balances) {
            console.log(`       💰 Balance (${b.balance_type}): ${b.balance_amount.amount} ${b.balance_amount.currency}`);
          }
        } catch (balErr) {
          console.log(`       ⚠️ Could not fetch balance yet: ${(balErr as Error).message}`);
        }
      }

      sessionStore.saveBankConnection({
        bank_key: bankKey,
        aspsp_name: aspspName,
        aspsp_country: aspspCountry,
        session_id: fullSession.session_id,
        account_uids: accountUids,
        accounts_data: accounts,
        valid_until: fullSession.valid_until || new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
      });

      console.log(`\n✅ Successfully imported and saved ${aspspName} to SQLite database!`);
    } catch (err) {
      console.error(`\n❌ Failed to import session ${sessionId}: ${(err as Error).message}\n`);
    }
  }

  const allConnected = sessionStore.getAllBankConnections();
  console.log(`\n📊 Current Connected Banks in Database (${allConnected.length}):`);
  for (const conn of allConnected) {
    console.log(`   • ${conn.aspsp_name} (${conn.bank_key}): ${conn.account_uids.length} account(s), valid until ${conn.valid_until}`);
  }
  console.log('\n');
}

main().catch(console.error);
