import { CleanTransaction, SubscriptionItem } from '../analysis/polish-finance.js';
import { ImprovementPlanState } from './plan-store.js';

export interface ExpectedExpenseItem {
  name: string;
  category: string;
  expectedDate: string; // YYYY-MM-DD
  amountPln: number;
  type: 'subscription' | 'invoice' | 'groceries_baseline';
}

export interface DigestAnalysisResult {
  date: string; // YYYY-MM-DD
  todayTransactions: CleanTransaction[];
  totalSpentTodayPln: number;
  internalTransfersExcluded: Array<{ merchant: string; amount: number }>;
  harmfulTransactions: Array<{
    transaction: CleanTransaction;
    reason: string;
    countermeasure: string;
    timeEstimate: string;
  }>;
  debtTransactions: Array<{
    transaction: CleanTransaction;
    type: 'bnpl_new_debt' | 'bnpl_installment' | 'credit_card_repayment' | 'credit_card_charge';
    provider: string;
  }>;
  upcomingExpenses: ExpectedExpenseItem[];
  totalUpcomingWeekPln: number;
  safeDailySpendPln: number;
  liquidBalancePln: number;
  winMessage?: string;
}

export interface FormattedDigest {
  subject: string;
  text: string;
  html: string;
  primaryAction: string;
}

export function formatAdhdDigest(analysis: DigestAnalysisResult, plan: ImprovementPlanState): FormattedDigest {
  const currentStep = plan.steps.find(s => s.step_number === plan.current_step) || plan.steps[0];
  const harmfulCount = analysis.harmfulTransactions.length;

  // Determine Primary Action (Rule 1: Lead with the next action)
  let primaryAction = '';
  if (harmfulCount > 0) {
    const topHarm = analysis.harmfulTransactions[0];
    primaryAction = `${topHarm.countermeasure} (${topHarm.timeEstimate})`;
  } else if (analysis.debtTransactions.some(d => d.type === 'bnpl_new_debt')) {
    primaryAction = `Turn off Pay Later as default checkout on Allegro/stores (2 min)`;
  } else if (plan.debt_tracker.estimated_monthly_bnpl_repayments_pln > 0) {
    primaryAction = `Log into PayPo or Allegro Pay and check next payoff due date (2 min)`;
  } else {
    primaryAction = `Open your banking app and verify current liquid buffer (${analysis.liquidBalancePln.toFixed(0)} PLN) (1 min)`;
  }

  const subject = harmfulCount > 0 
    ? `ADHD Budget: 1 action today — fix ${analysis.harmfulTransactions[0].transaction.merchant} leak (${analysis.harmfulTransactions[0].timeEstimate})`
    : `ADHD Budget: Clean day (+win logged) — next week forecast ready`;

  // --- Plain Text Format (Strict i-have-adhd rules) ---
  const textLines: string[] = [
    `ACTION NOW: ${primaryAction}`,
    '',
    `STATE: Step ${currentStep.step_number} of 5: ${currentStep.title}`,
    `• Focus: ${currentStep.focus}`,
    `• Liquid Balance: ${analysis.liquidBalancePln.toFixed(2)} PLN`,
    `• Clean Streak: ${plan.habits_tracker.consecutive_days_without_harmful_spend} day(s) without harmful spend`,
    '',
  ];

  // Make wins visible (Dopamine hit)
  if (analysis.winMessage) {
    textLines.push(`✓ WIN TODAY: ${analysis.winMessage}`);
    textLines.push('');
  } else if (harmfulCount === 0) {
    textLines.push(`✓ WIN TODAY: Zero harmful or impulsive purchases today (+saved vs avg daily pace).`);
    textLines.push('');
  }

  // Today's harmful transactions & elimination plan
  textLines.push(`TODAY'S TRANSACTIONS (${analysis.todayTransactions.length} total, ${analysis.totalSpentTodayPln.toFixed(2)} PLN spent):`);
  if (analysis.internalTransfersExcluded.length > 0) {
    textLines.push(`• Note: ${analysis.internalTransfersExcluded.length} internal transfer(s) (${analysis.internalTransfersExcluded.reduce((a, b) => a + b.amount, 0).toFixed(2)} PLN) excluded.`);
  }

  if (harmfulCount > 0) {
    textLines.push(`⚠️ HARMFUL TO PLAN (${harmfulCount}):`);
    for (const h of analysis.harmfulTransactions) {
      textLines.push(`  - ${h.transaction.merchant} (${Math.abs(h.transaction.amount).toFixed(2)} ${h.transaction.currency}): ${h.reason}`);
      textLines.push(`    -> Fix (${h.timeEstimate}): ${h.countermeasure}`);
    }
  } else {
    textLines.push(`• No harmful impulse transactions detected today.`);
  }
  textLines.push('');

  // Next week's expected expenses & optimization
  textLines.push(`NEXT 7 DAYS EXPECTED EXPENSES (Total: ~${analysis.totalUpcomingWeekPln.toFixed(0)} PLN):`);
  if (analysis.upcomingExpenses.length > 0) {
    for (const exp of analysis.upcomingExpenses) {
      textLines.push(`• ${exp.expectedDate.slice(5)}: ${exp.name} — ${exp.amountPln.toFixed(2)} PLN (${exp.category})`);
    }
  } else {
    textLines.push(`• No major subscription fees expected in the next 7 days.`);
  }
  textLines.push(`• Safe daily spend allowance: ${analysis.safeDailySpendPln.toFixed(0)} PLN/day.`);
  textLines.push(`• Optimization tip: Consolidate grocery runs to 1-2 major discount store trips (Biedronka/Lidl) to avoid frequent convenience store markups.`);
  textLines.push('');

  // Numbered multi-step work (Rule 2: Number multi-step tasks, <= 3 steps)
  textLines.push(`NEXT ACTIONS FOR TONIGHT:`);
  textLines.push(`1. ${primaryAction}`);
  textLines.push(`2. Check your calendar against next week's ${analysis.totalUpcomingWeekPln.toFixed(0)} PLN commitments (2 min)`);
  textLines.push('');

  // End with ONE concrete next action (Rule 3)
  textLines.push(`NEXT (2 min): Complete step 1 right now and close this email.`);

  const plainText = textLines.join('\n');

  // --- High-Contrast Dark HTML Format (Mobile Friendly) ---
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  <style>
    body {
      background-color: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 16px;
      line-height: 1.5;
    }
    .card {
      background-color: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 20px;
      max-width: 540px;
      margin: 0 auto;
    }
    .action-banner {
      background: rgba(59, 130, 246, 0.2);
      border-left: 4px solid #3b82f6;
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 20px;
    }
    .action-banner strong {
      color: #60a5fa;
      display: block;
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .action-banner p {
      margin: 4px 0 0 0;
      font-size: 1.05rem;
      font-weight: 600;
      color: #ffffff;
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-win { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .badge-warn { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .section-title {
      font-size: 0.9rem;
      font-weight: 700;
      text-transform: uppercase;
      color: #94a3b8;
      letter-spacing: 0.05em;
      margin-top: 20px;
      margin-bottom: 8px;
    }
    ul {
      margin: 0;
      padding-left: 20px;
    }
    li {
      margin-bottom: 6px;
      font-size: 0.95rem;
    }
    .stat-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #334155;
      font-size: 0.9rem;
    }
    .next-box {
      background: #090d16;
      border: 1px solid #3b82f6;
      border-radius: 8px;
      padding: 12px;
      margin-top: 20px;
      text-align: center;
      font-weight: 600;
      color: #38bdf8;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="action-banner">
      <strong>⚡ Action Now (Do First)</strong>
      <p>${primaryAction}</p>
    </div>

    <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; margin-bottom: 16px;">
      <div style="font-size: 0.8rem; color: #94a3b8;">CURRENT STATE</div>
      <div style="font-weight: 700; font-size: 1.1rem; color: #f8fafc;">
        Step ${currentStep.step_number} of 5: ${currentStep.title}
      </div>
      <div style="font-size: 0.85rem; color: #cbd5e1; margin-top: 4px;">
        Liquid: <strong>${analysis.liquidBalancePln.toFixed(2)} PLN</strong> | Clean Streak: <strong>${plan.habits_tracker.consecutive_days_without_harmful_spend}d</strong>
      </div>
    </div>

    ${analysis.winMessage || harmfulCount === 0 ? `
      <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px;">
        <span class="badge badge-win">✓ Win Logged</span>
        <div style="font-size: 0.95rem; color: #e2e8f0; margin-top: 4px;">
          ${analysis.winMessage || 'Zero harmful or impulsive purchases today. Safe spending maintained!'}
        </div>
      </div>
    ` : ''}

    <div class="section-title">Today's Transactions Review</div>
    ${harmfulCount > 0 ? `
      <div style="background: rgba(239, 68, 68, 0.1); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
        <span class="badge badge-warn">Harmful to Plan (${harmfulCount})</span>
        <ul style="margin-top: 8px; padding-left: 18px;">
          ${analysis.harmfulTransactions.map(h => `
            <li>
              <strong>${h.transaction.merchant}</strong> (${Math.abs(h.transaction.amount).toFixed(2)} ${h.transaction.currency}): ${h.reason}
              <br/><span style="color: #60a5fa;">&rarr; Fix (${h.timeEstimate}): ${h.countermeasure}</span>
            </li>
          `).join('')}
        </ul>
      </div>
    ` : `
      <p style="font-size: 0.9rem; color: #34d399; margin: 0 0 12px 0;">✓ All purchases today were normal planned living expenses.</p>
    `}

    <div class="section-title">Next 7 Days Forecast (~${analysis.totalUpcomingWeekPln.toFixed(0)} PLN)</div>
    <ul>
      ${analysis.upcomingExpenses.slice(0, 5).map(e => `
        <li>${e.expectedDate.slice(5)}: <strong>${e.name}</strong> — ${e.amountPln.toFixed(2)} PLN (${e.category})</li>
      `).join('')}
      <li>Daily living baseline + groceries: ~350–400 PLN</li>
    </ul>
    <p style="font-size: 0.85rem; color: #94a3b8; margin: 6px 0 0 0;">
      💡 <strong>Optimization:</strong> Batch grocery runs into 1-2 major supermarket stops to avoid daily convenience store leaks.
    </p>

    <div class="next-box">
      Next (2 min): Complete step 1 right now and close this email.
    </div>
  </div>
</body>
</html>`;

  return {
    subject,
    text: plainText,
    html,
    primaryAction,
  };
}
