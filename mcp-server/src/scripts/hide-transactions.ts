import { readFileSync } from 'node:fs';
import { SessionStore } from '../enable-banking/session-store.js';

interface HideSpec {
  reason: string;
  entries: Array<{
    account_id: string;
    entry_reference?: string;
    transaction_id?: string;
    label?: string;
  }>;
}

function usage(): never {
  console.log(`
Usage: node dist/scripts/hide-transactions.js <spec.json> [--db <path>] [--apply]

Soft-deletes (tombstones) transactions so every read path filters them out —
now and on every future bank re-fetch. Raw data stays in account_cache.

spec.json:
{
  "reason": "pko-bp-credit-card-chain",
  "entries": [
    { "account_id": "<uid>", "entry_reference": "O;211", "label": "repayment card *5014" }
  ]
}

Dry-run by default; pass --apply to persist.
Undo: new SessionStore(db).unhideTransactions({ reason: '<reason>' })
`);
  process.exit(2);
}

function parseArgs(argv: string[]): { specPath: string; dbPath: string; apply: boolean } {
  const args = argv.slice(2);
  const dbIdx = args.indexOf('--db');
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : './data/sessions.db';
  // The spec is the first positional arg that is not a flag and not --db's value
  const specPath = args.find((a, i) => !a.startsWith('--') && i !== dbIdx + 1);
  const apply = args.includes('--apply');
  if (!specPath || !dbPath) usage();
  return { specPath, dbPath, apply };
}

function main(): void {
  const { specPath, dbPath, apply } = parseArgs(process.argv);

  let spec: HideSpec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf-8')) as HideSpec;
  } catch (err) {
    console.error(`Failed to read spec ${specPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!spec.reason || !Array.isArray(spec.entries) || spec.entries.length === 0) {
    console.error('Spec must contain a non-empty "reason" and "entries" array');
    process.exit(1);
  }

  const store = new SessionStore(dbPath);
  const db = store.getDb();

  const resolved: Array<{ accountId: string; tx: unknown; label: string }> = [];
  const missing: HideSpec['entries'] = [];

  for (const entry of spec.entries) {
    const row = db.prepare('SELECT transactions_json FROM account_cache WHERE account_id = ?').get(entry.account_id) as { transactions_json?: string } | undefined;
    const txs = row?.transactions_json ? (JSON.parse(row.transactions_json) as Array<Record<string, unknown>>) : [];
    const ref = entry.entry_reference ?? entry.transaction_id;
    const tx = txs.find(t => t.entry_reference === ref || t.transaction_id === ref);
    if (!tx) {
      missing.push(entry);
      continue;
    }
    resolved.push({ accountId: entry.account_id, tx, label: entry.label || ref || '' });
  }

  console.log(`Resolved ${resolved.length}/${spec.entries.length} transactions (db: ${dbPath}):`);
  for (const r of resolved) {
    const t = r.tx as { booking_date?: string; value_date?: string; credit_debit_indicator?: string; transaction_amount?: { amount?: string } };
    console.log(`  ${r.accountId.slice(0, 8)} ${t.booking_date || t.value_date || '?'} ${t.credit_debit_indicator || '?'} ${String(t.transaction_amount?.amount ?? '?').padStart(10)} | ${r.label}`);
  }
  if (missing.length > 0) {
    console.error(`\n${missing.length} entries not found in account_cache — aborting:`);
    for (const m of missing) console.error('  ', JSON.stringify(m));
    const available = (db.prepare('SELECT DISTINCT account_id FROM account_cache ORDER BY account_id').all() as Array<{ account_id: string }>).map(r => r.account_id);
    console.error(`\nAccounts present in this database:\n  ${available.join('\n  ')}`);
    store.close();
    process.exit(1);
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to persist.');
    store.close();
    return;
  }

  const { transactions, keysWritten } = store.hideTransactions(
    resolved.map(r => ({ accountId: r.accountId, tx: r.tx, reason: spec.reason })),
  );
  console.log(`\nApplied: ${keysWritten} tombstone keys for ${transactions} transactions (reason=${spec.reason})`);

  // Verify through the actual read path (getAccountTransactions), not by re-deriving keys.
  // Note: `!= null` — Enable Banking transactions can carry explicit null identifiers.
  const survivors: string[] = [];
  for (const r of resolved) {
    const t = r.tx as Record<string, unknown>;
    const visible = (store.getAccountTransactions(r.accountId) || []) as Array<Record<string, unknown>>;
    const found = visible.some(v => {
      const tRef = t.entry_reference as string | null | undefined;
      const vRef = v.entry_reference as string | null | undefined;
      if (tRef != null && vRef != null) return tRef === vRef;
      const tTid = t.transaction_id as string | null | undefined;
      const vTid = v.transaction_id as string | null | undefined;
      if (tTid != null && vTid != null) return tTid === vTid;
      // identifier-less: compare full content
      return JSON.stringify(t) === JSON.stringify(v);
    });
    if (found) survivors.push(`${r.accountId.slice(0, 8)} ${r.label}`);
  }
  console.log(`Verification: ${survivors.length} still visible via read path (expected 0)`);
  if (survivors.length > 0) {
    for (const s of survivors) console.error(`  STILL VISIBLE: ${s}`);
    store.close();
    process.exit(1);
  }
  store.close();
}

main();
