import { CleanTransaction } from '../analysis/polish-finance.js';
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
  totalIncomeTodayPln: number;
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
  creditDebtPln: number;
  netBalancePln: number;
  foreignBalances?: Array<{ currency: string; amount: number }>;
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
    primaryAction = 'Wyłącz odroczone płatności (PayPo / Allegro Pay) jako metodę w kasie (2 min)';
  } else if (analysis.creditDebtPln > 0) {
    primaryAction = `Sprawdź w Revolut/banku termin spłaty karty (${analysis.creditDebtPln.toFixed(0)} PLN długu) (2 min)`;
  } else if (plan.debt_tracker.estimated_monthly_bnpl_repayments_pln > 0) {
    primaryAction = 'Zaloguj się do PayPo / Allegro Pay i sprawdź termin najbliższej spłaty (2 min)';
  } else {
    primaryAction = `Zaloguj się do banku i potwierdź bezpieczny bufor (${analysis.liquidBalancePln.toFixed(0)} PLN) (1 min)`;
  }

  const subject = harmfulCount > 0 
    ? `ADHD Budżet: 1 zadanie na dziś — wyciek w ${analysis.harmfulTransactions[0].transaction.merchant} (${analysis.harmfulTransactions[0].timeEstimate})`
    : `ADHD Budżet: Czysty dzień (+sukces) — prognoza na ten tydzień`;

  // Foreign balances line if available
  const foreignParts = (analysis.foreignBalances || [])
    .filter(f => f.currency !== 'PLN' && f.amount > 0)
    .map(f => `${f.amount.toFixed(2)} ${f.currency}`);
  const foreignLine = foreignParts.length > 0 ? `• Oszczędności walutowe: ${foreignParts.join(', ')}` : '';

  // --- Plain Text Format (Strict i-have-adhd rules in Polish) ---
  const textLines: string[] = [
    `AKCJA TERAZ: ${primaryAction}`,
    '',
    `STAN: Krok ${currentStep.step_number} z 5: ${currentStep.title}`,
    `• Cel: ${currentStep.target_goal}`,
    `• Dostępna gotówka (PLN): ${analysis.liquidBalancePln.toFixed(2)} PLN`,
  ];

  if (foreignLine) {
    textLines.push(foreignLine);
  }

  if (analysis.creditDebtPln > 0) {
    textLines.push(`• Zadłużenie na kartach/limitach: ${analysis.creditDebtPln.toFixed(2)} PLN`);
    textLines.push(`• Bilans netto (PLN): ${analysis.netBalancePln.toFixed(2)} PLN`);
  }

  textLines.push(`• Czysta seria: ${plan.habits_tracker.consecutive_days_without_harmful_spend} dni bez zbędnych wydatków`);
  textLines.push('');

  // Make wins visible (Dopamine hit)
  if (analysis.winMessage) {
    textLines.push(`✓ SUKCES DZISIAJ: ${analysis.winMessage}`);
    textLines.push('');
  } else if (harmfulCount === 0) {
    textLines.push(`✓ SUKCES DZISIAJ: Zero impulsywnych zakupów i brak nowego długu dzisiaj (+bufor ochroniony).`);
    textLines.push('');
  }

  // Today's transactions review
  const incomeSummary = analysis.totalIncomeTodayPln > 0 ? `, +${analysis.totalIncomeTodayPln.toFixed(2)} PLN wpływów` : '';
  textLines.push(`DZISIEJSZE TRANSAKCJE (${analysis.todayTransactions.length} łącznie, ${analysis.totalSpentTodayPln.toFixed(2)} PLN wydatków${incomeSummary}):`);

  // Debt Repayments (wins!)
  const repayments = analysis.debtTransactions.filter(d => d.type === 'bnpl_installment' || d.type === 'credit_card_repayment');
  if (repayments.length > 0) {
    const totalRepaid = repayments.reduce((s, d) => s + Math.abs(d.transaction.amount), 0);
    textLines.push(`🎉 SPŁATY ZADŁUŻENIA (${repayments.length}, +${totalRepaid.toFixed(2)} PLN na zmniejszenie długu):`);
    for (const rep of repayments) {
      textLines.push(`  ✓ ${rep.transaction.merchant || rep.provider} (+${Math.abs(rep.transaction.amount).toFixed(2)} ${rep.transaction.currency}) — spłata długu / raty`);
    }
  }

  // Incomes & Refunds
  const incomes = analysis.todayTransactions.filter(t => (t.is_income || t.amount > 0) && !repayments.some(r => r.transaction.id === t.id));
  if (incomes.length > 0) {
    textLines.push(`• Wpływy i zwroty (+${analysis.totalIncomeTodayPln.toFixed(2)} PLN):`);
    for (const inc of incomes) {
      textLines.push(`  + ${inc.merchant} (+${inc.amount.toFixed(2)} ${inc.currency})`);
    }
  }

  if (analysis.internalTransfersExcluded.length > 0) {
    const totalExcluded = analysis.internalTransfersExcluded.reduce((a, b) => a + b.amount, 0);
    textLines.push(`• Transfery wewnętrzne: ${analysis.internalTransfersExcluded.length} przelew(y) (${totalExcluded.toFixed(2)} PLN) wykluczone z wydatków konsumpcyjnych.`);
  }

  // Harmful transactions
  if (harmfulCount > 0) {
    textLines.push(`⚠️ SZKODLIWE DLA PLANU (${harmfulCount}):`);
    for (const h of analysis.harmfulTransactions) {
      textLines.push(`  - ${h.transaction.merchant} (${Math.abs(h.transaction.amount).toFixed(2)} ${h.transaction.currency}): ${h.reason}`);
      textLines.push(`    -> Rozwiązanie (${h.timeEstimate}): ${h.countermeasure}`);
    }
  }

  // Convenience & Habit Spending watchlist (Żabka, sweets, energy drinks, nicotine)
  const convenienceTxs = analysis.todayTransactions.filter(
    t => t.merchant === 'Żabka' || t.category === 'Convenience / Snacks'
  );
  if (convenienceTxs.length > 0) {
    const totalConvenience = convenienceTxs.reduce((sum, t) => sum + Math.abs(t.amount), 0);
    textLines.push(`👁️ POD OBSERWACJĄ — NAWYKI I PRZEKĄSKI (Żabka: ${totalConvenience.toFixed(2)} PLN dzisiaj):`);
    textLines.push(`  • ${convenienceTxs.length} zakupy w Żabce (${convenienceTxs.map(t => `${Math.abs(t.amount).toFixed(2)} PLN`).join(', ')}).`);
    textLines.push(`  💡 Wskazówka: Drobne zakupy (słodycze, nikotyna, napoje) to wygoda, ale kumulują się z marżą convenience. Kupuj ulubione rzeczy z wyprzedzeniem w dyskoncie.`);
  }

  // Normal living expenses
  const normalExpenses = analysis.todayTransactions.filter(
    t => !t.is_income && t.amount < 0 && !t.is_internal_transfer && !analysis.harmfulTransactions.some(h => h.transaction.id === t.id)
  );
  if (normalExpenses.length > 0) {
    textLines.push(`• Pozostałe normalne wydatki (${normalExpenses.length}):`);
    for (const exp of normalExpenses) {
      const creditTag = exp.is_credit_account ? ' [Karta kredytowa]' : '';
      textLines.push(`  - ${exp.merchant} (${Math.abs(exp.amount).toFixed(2)} ${exp.currency}) [${exp.category}]${creditTag}`);
    }
  } else if (harmfulCount === 0 && incomes.length === 0 && repayments.length === 0) {
    textLines.push(`• Brak wydatków ani transakcji dzisiaj.`);
  }
  textLines.push('');

  // Next week's expected expenses & optimization
  textLines.push(`PROGNOZA NA NAJBLIŻSZE 7 DNI (Suma: ~${analysis.totalUpcomingWeekPln.toFixed(0)} PLN):`);
  if (analysis.upcomingExpenses.length > 0) {
    for (const exp of analysis.upcomingExpenses) {
      textLines.push(`• ${exp.expectedDate.slice(5)}: ${exp.name} — ${exp.amountPln.toFixed(2)} PLN (${exp.category})`);
    }
  } else {
    textLines.push(`• Brak większych subskrypcji do zapłaty w najbliższych 7 dniach.`);
  }
  textLines.push(`• Bezpieczny dzienny limit wydatków: ${analysis.safeDailySpendPln.toFixed(0)} PLN/dzień.`);
  textLines.push(`• Wskazówka optymalizacyjna: Zrób 1-2 większe zakupy w dyskoncie (Biedronka/Lidl), aby uniknąć częstych i drogich zakupów w Żabkach.`);
  textLines.push('');

  // Numbered multi-step work (Rule 2: Number multi-step tasks, <= 3 steps)
  textLines.push(`ZADANIA NA DZISIAJ WIECZÓR:`);
  textLines.push(`1. ${primaryAction}`);
  textLines.push(`2. Sprawdź w kalendarzu zobowiązania na najbliższy tydzień (~${analysis.totalUpcomingWeekPln.toFixed(0)} PLN) (2 min)`);
  textLines.push('');

  // End with ONE concrete next action (Rule 3)
  textLines.push(`DALEJ (2 min): Wykonaj krok 1 teraz i zamknij tego maila.`);

  const plainText = textLines.join('\n');

  // --- High-Contrast Dark HTML Format (Mobile Friendly, in Polish) ---
  const html = `<!DOCTYPE html>
<html lang="pl">
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
    .badge-info { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
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
      padding: 6px 0;
      border-bottom: 1px solid #334155;
      font-size: 0.88rem;
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
      <strong>⚡ Akcja Teraz (Zrób najpierw)</strong>
      <p>${primaryAction}</p>
    </div>

    <div style="background: rgba(255,255,255,0.03); padding: 12px 14px; border-radius: 8px; margin-bottom: 16px;">
      <div style="font-size: 0.8rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em;">STAN BUDŻETU</div>
      <div style="font-weight: 700; font-size: 1.05rem; color: #f8fafc; margin-top: 2px;">
        Krok ${currentStep.step_number} z 5: ${currentStep.title}
      </div>
      <div style="margin-top: 8px;">
        <div class="stat-row">
          <span style="color: #94a3b8;">Dostępna gotówka (PLN):</span>
          <strong style="color: #34d399;">${analysis.liquidBalancePln.toFixed(2)} PLN</strong>
        </div>
        ${foreignParts.length > 0 ? `
        <div class="stat-row">
          <span style="color: #94a3b8;">Waluty (oszczędności):</span>
          <strong style="color: #38bdf8;">${foreignParts.join(', ')}</strong>
        </div>
        ` : ''}
        ${analysis.creditDebtPln > 0 ? `
        <div class="stat-row">
          <span style="color: #94a3b8;">Zadłużenie (karty/limity):</span>
          <strong style="color: #f87171;">-${analysis.creditDebtPln.toFixed(2)} PLN</strong>
        </div>
        <div class="stat-row">
          <span style="color: #94a3b8;">Bilans netto (PLN):</span>
          <strong style="color: ${analysis.netBalancePln >= 0 ? '#34d399' : '#fca5a5'};">${analysis.netBalancePln.toFixed(2)} PLN</strong>
        </div>
        ` : ''}
        <div class="stat-row" style="border-bottom: none;">
          <span style="color: #94a3b8;">Czysta seria bez zbędnych zakupów:</span>
          <strong style="color: #f8fafc;">${plan.habits_tracker.consecutive_days_without_harmful_spend} dni</strong>
        </div>
      </div>
    </div>

    ${analysis.winMessage || harmfulCount === 0 ? `
      <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px;">
        <span class="badge badge-win">✓ Sukces dzisiaj</span>
        <div style="font-size: 0.92rem; color: #e2e8f0; margin-top: 4px;">
          ${analysis.winMessage || 'Zero impulsywnych zakupów i brak nowego długu. Twój bufor jest ochroniony!'}
        </div>
      </div>
    ` : ''}

    <div class="section-title">Przegląd dzisiejszych transakcji</div>

    ${repayments.length > 0 ? `
      <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
        <span class="badge badge-win">🎉 Spłaty zadłużenia (${repayments.length})</span>
        <ul style="margin-top: 6px; padding-left: 18px;">
          ${repayments.map(r => `
            <li><strong>${r.transaction.merchant || r.provider}</strong>: spłacono +${Math.abs(r.transaction.amount).toFixed(2)} ${r.transaction.currency}</li>
          `).join('')}
        </ul>
      </div>
    ` : ''}

    ${incomes.length > 0 ? `
      <div style="background: rgba(59, 130, 246, 0.1); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
        <span class="badge badge-info">Wpływy i zwroty (+${analysis.totalIncomeTodayPln.toFixed(2)} PLN)</span>
        <ul style="margin-top: 6px; padding-left: 18px;">
          ${incomes.map(i => `
            <li><strong>${i.merchant}</strong>: +${i.amount.toFixed(2)} ${i.currency}</li>
          `).join('')}
        </ul>
      </div>
    ` : ''}

    ${harmfulCount > 0 ? `
      <div style="background: rgba(239, 68, 68, 0.1); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
        <span class="badge badge-warn">Szkodliwe dla planu (${harmfulCount})</span>
        <ul style="margin-top: 8px; padding-left: 18px;">
          ${analysis.harmfulTransactions.map(h => `
            <li>
              <strong>${h.transaction.merchant}</strong> (${Math.abs(h.transaction.amount).toFixed(2)} ${h.transaction.currency}): ${h.reason}
              <br/><span style="color: #60a5fa;">&rarr; Rozwiązanie (${h.timeEstimate}): ${h.countermeasure}</span>
            </li>
          `).join('')}
        </ul>
      </div>
    ` : ''}

    ${convenienceTxs.length > 0 ? `
      <div style="background: rgba(234, 179, 8, 0.08); border: 1px solid rgba(234, 179, 8, 0.25); border-left: 4px solid #eab308; padding: 10px 14px; border-radius: 8px; margin-bottom: 12px;">
        <span class="badge" style="background: rgba(234, 179, 8, 0.2); color: #facc15;">👁️ Pod obserwacją — Nawyki i przekąski (Żabka)</span>
        <div style="font-size: 0.92rem; color: #e2e8f0; margin-top: 6px;">
          <strong>${convenienceTxs.length} zakupy</strong> o łącznej wartości <strong>${convenienceTxs.reduce((s, t) => s + Math.abs(t.amount), 0).toFixed(2)} PLN</strong>.
        </div>
        <div style="font-size: 0.82rem; color: #94a3b8; margin-top: 4px;">
          To nie jest zły wydatek, ale drobne zakupy (słodycze, nikotyna, energetyki) kumulują się w tle. Zrób zapas ulubionych produktów w dyskoncie, by nie przepłacać z marżą convenience.
        </div>
      </div>
    ` : ''}

    ${normalExpenses.length > 0 ? `
      <div style="background: rgba(255, 255, 255, 0.03); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
        <div style="font-size: 0.8rem; color: #94a3b8; margin-bottom: 6px;">NORMALNE KOSZTY ŻYCIA (${normalExpenses.length}):</div>
        <ul style="padding-left: 18px;">
          ${normalExpenses.map(e => `
            <li><strong>${e.merchant}</strong> (${Math.abs(e.amount).toFixed(2)} ${e.currency}) <span style="color: #64748b;">— ${e.category}</span>${e.is_credit_account ? ' <span class="badge badge-warn" style="font-size: 0.7rem; padding: 1px 6px;">Karta kredytowa</span>' : ''}</li>
          `).join('')}
        </ul>
      </div>
    ` : ''}

    ${harmfulCount === 0 && normalExpenses.length === 0 && incomes.length === 0 && repayments.length === 0 ? `
      <p style="font-size: 0.9rem; color: #34d399; margin: 0 0 12px 0;">✓ Brak transakcji dzisiaj.</p>
    ` : ''}

    <div class="section-title">Prognoza na 7 dni (~${analysis.totalUpcomingWeekPln.toFixed(0)} PLN)</div>
    <ul>
      ${analysis.upcomingExpenses.slice(0, 5).map(e => `
        <li>${e.expectedDate.slice(5)}: <strong>${e.name}</strong> — ${e.amountPln.toFixed(2)} PLN (${e.category})</li>
      `).join('')}
      <li>Stały koszt życia + zakupy spożywcze: ~350–400 PLN</li>
    </ul>
    <p style="font-size: 0.85rem; color: #94a3b8; margin: 6px 0 0 0;">
      💡 <strong>Optymalizacja:</strong> Zrób 1-2 większe zakupy w dyskoncie (Biedronka/Lidl), aby uniknąć częstych i drogich zakupów w Żabkach.
    </p>

    <div class="next-box">
      Dalej (2 min): Wykonaj krok 1 teraz i zamknij tego maila.
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
