export interface CleanTransaction {
  id: string;
  bank: string;
  account_id: string;
  owner?: string;
  date: string;
  amount: number;
  currency: string;
  merchant: string;
  category: string;
  raw_description: string;
  is_internal_transfer: boolean;
  is_income: boolean;
  is_credit_account?: boolean;
  is_outlier?: boolean;
  outlier_reason?: string;
}

export interface SpendingAnalysis {
  period: string;
  date_from: string;
  date_to: string;
  total_spent_pln: number;
  total_income_pln: number;
  daily_burn_rate_pln: number;
  transaction_count: number;
  top_merchants: Array<{ merchant: string; category: string; amount: number; count: number }>;
  categories_breakdown: Record<string, number>;
  by_owner?: Record<string, { total_spent_pln: number; transaction_count: number }>;
  outliers: CleanTransaction[];
  internal_transfers_excluded: Array<{ merchant: string; amount: number; date: string }>;
}

export interface SubscriptionItem {
  merchant: string;
  category: string;
  monthly_amount: number;
  occurrences: number;
  last_date: string;
  frequency: 'monthly' | 'weekly' | 'irregular';
  owner?: string;
}

export interface CashflowForecast {
  current_liquid_balance_pln: number;
  days_in_month: number;
  day_of_month: number;
  days_remaining: number;
  spent_so_far_pln: number;
  current_daily_burn_rate_pln: number;
  estimated_upcoming_recurring_pln: number;
  projected_month_end_balance_pln: number;
  safe_daily_spend_limit_pln: number;
  status: 'on_track' | 'warning' | 'deficit_risk';
  advice: string;
}

// Known Polish merchant patterns (regex -> clean name + category)
const MERCHANT_PATTERNS: Array<{ regex: RegExp; name: string; category: string }> = [
  // Groceries
  { regex: /biedronka/i, name: 'Biedronka', category: 'Groceries' },
  { regex: /żabka|zabka/i, name: 'Żabka', category: 'Convenience / Snacks' },
  { regex: /dino\s+(polska|nr)?/i, name: 'Dino', category: 'Groceries' },
  { regex: /lidl/i, name: 'Lidl', category: 'Groceries' },
  { regex: /kaufland/i, name: 'Kaufland', category: 'Groceries' },
  { regex: /auchan/i, name: 'Auchan', category: 'Groceries' },
  { regex: /carrefour/i, name: 'Carrefour', category: 'Groceries' },
  { regex: /stokrotka/i, name: 'Stokrotka', category: 'Groceries' },
  { regex: /netto/i, name: 'Netto', category: 'Groceries' },
  { regex: /frisco/i, name: 'Frisco', category: 'Groceries' },
  { regex: /wolt/i, name: 'Wolt', category: 'Groceries' },

  // Fuel & Transport
  { regex: /orlen/i, name: 'Orlen', category: 'Transport & Fuel' },
  { regex: /bp\s+|stacja\s+bp/i, name: 'BP', category: 'Transport & Fuel' },
  { regex: /shell/i, name: 'Shell', category: 'Transport & Fuel' },
  { regex: /circle\s*k/i, name: 'Circle K', category: 'Transport & Fuel' },
  { regex: /mol\s+polska/i, name: 'MOL', category: 'Transport & Fuel' },
  { regex: /uber/i, name: 'Uber', category: 'Transport & Fuel' },
  { regex: /bolt/i, name: 'Bolt', category: 'Transport & Fuel' },
  { regex: /freenow/i, name: 'FreeNow', category: 'Transport & Fuel' },
  { regex: /jakdojade/i, name: 'Jakdojade', category: 'Transport & Fuel' },
  { regex: /ztm|mpk|koleje|pkp\s+intercity/i, name: 'Public Transit', category: 'Transport & Fuel' },
  { regex: /autodirect|autopay/i, name: 'Autopay', category: 'Transport & Fuel' },
  { regex: /traficar/i, name: 'Traficar', category: 'Transport & Fuel' },

  // E-commerce & Shopping
  { regex: /allegro/i, name: 'Allegro', category: 'Shopping' },
  { regex: /amazon/i, name: 'Amazon', category: 'Shopping' },
  { regex: /inpost|paczkomat/i, name: 'InPost', category: 'Shopping' },
  { regex: /aliexpress/i, name: 'AliExpress', category: 'Shopping' },
  { regex: /zalando/i, name: 'Zalando', category: 'Shopping' },
  { regex: /empik/i, name: 'Empik', category: 'Shopping' },
  { regex: /ikea/i, name: 'IKEA', category: 'Shopping' },
  { regex: /leroy\s+merlin|castorama|obi/i, name: 'Home Improvement', category: 'Shopping' },
  { regex: /media\s*markt|rtv\s*euro\s*agd|x-kom|morele/i, name: 'Electronics', category: 'Shopping' },
  { regex: /rossmann/i, name: 'Rossmann', category: 'Health & Beauty' },
  { regex: /hebe/i, name: 'Hebe', category: 'Health & Beauty' },
  { regex: /apteka|doz\.pl|gemini/i, name: 'Pharmacy', category: 'Health & Beauty' },

  // Dining & Food Delivery
  { regex: /pyszne\.pl|pyszne/i, name: 'Pyszne.pl', category: 'Dining' },
  { regex: /glovo/i, name: 'Glovo', category: 'Dining' },
  { regex: /uber\s*eats/i, name: 'Uber Eats', category: 'Dining' },
  { regex: /mcdonald/i, name: "McDonald's", category: 'Dining' },
  { regex: /kfc/i, name: 'KFC', category: 'Dining' },
  { regex: /starbucks|costa\s+coffee/i, name: 'Coffee', category: 'Dining' },

  // Subscriptions & Tech
  { regex: /netflix/i, name: 'Netflix', category: 'Subscriptions' },
  { regex: /spotify/i, name: 'Spotify', category: 'Subscriptions' },
  { regex: /youtube|google\s*\*\s*youtube/i, name: 'YouTube Premium', category: 'Subscriptions' },
  { regex: /apple\.com|itunes/i, name: 'Apple Services', category: 'Subscriptions' },
  { regex: /google\s*\*\s*(storage|cloud|play)/i, name: 'Google Services', category: 'Subscriptions' },
  { regex: /disney\s*(\+|plus)/i, name: 'Disney+', category: 'Subscriptions' },
  { regex: /hbo|max\.com/i, name: 'HBO Max', category: 'Subscriptions' },
  { regex: /steamgames|valve/i, name: 'Steam', category: 'Entertainment' },
  { regex: /playstation|sony/i, name: 'PlayStation', category: 'Entertainment' },
  { regex: /chatgpt|openai/i, name: 'OpenAI', category: 'Subscriptions' },
  { regex: /anthropic|claude/i, name: 'Anthropic', category: 'Subscriptions' },
  { regex: /microsoft/i, name: 'Microsoft', category: 'Subscriptions' },
  { regex: /gym|fitness|calypso|zdrofit|mcfit/i, name: 'Gym / Fitness', category: 'Subscriptions' },

  // BNPL & Pay Later / Debt
  { regex: /allegro\s*pay/i, name: 'Allegro Pay', category: 'BNPL / Pay Later' },
  { regex: /paypo/i, name: 'PayPo', category: 'BNPL / Pay Later' },
  { regex: /twisto/i, name: 'Twisto', category: 'BNPL / Pay Later' },
  { regex: /klarna/i, name: 'Klarna', category: 'BNPL / Pay Later' },
  { regex: /revolut\s*pay\s*later/i, name: 'Revolut Pay Later', category: 'BNPL / Pay Later' },
  { regex: /spłata\s+karty|splata\s+karty/i, name: 'Credit Card Repayment', category: 'Debt Repayment' },
  { regex: /odsetki|prowizja\s+bankowa/i, name: 'Bank Interest & Fees', category: 'Bank Fees' },

  // Telecom & Utilities
  { regex: /orange\s+polska/i, name: 'Orange', category: 'Utilities' },
  { regex: /play|p4\s+sp/i, name: 'Play', category: 'Utilities' },
  { regex: /plus\s+gsm|polkomtel/i, name: 'Plus', category: 'Utilities' },
  { regex: /t-mobile/i, name: 'T-Mobile', category: 'Utilities' },
  { regex: /upc|vectra|inea/i, name: 'Internet / Cable', category: 'Utilities' },
  { regex: /pge|tauron|enea|energa/i, name: 'Electricity', category: 'Utilities' },
  { regex: /pgnig/i, name: 'Gas', category: 'Utilities' },
  { regex: /spółdzielnia|wspólnota|czynsz/i, name: 'Rent / Housing', category: 'Utilities' },
];

export function cleanMerchantAndCategory(description: string, creditorName?: string): { merchant: string; category: string } {
  const combined = `${creditorName || ''} ${description || ''}`.trim();

  for (const pattern of MERCHANT_PATTERNS) {
    if (pattern.regex.test(combined)) {
      return { merchant: pattern.name, category: pattern.category };
    }
  }

  // Fallback: clean up noisy bank prefixes
  let cleaned = (creditorName || description || 'Unknown')
    .replace(/^PŁATNOŚĆ KARTĄ\s+\d+\s+\d{2}\.\d{2}\.\d{4}\s+/i, '')
    .replace(/^ZAKUP PRZY UŻYCIU KODU BLIK\s+\d+\s+/i, '')
    .replace(/^PRZELEW KRAJOWY ELIXIR\s+/i, '')
    .replace(/^PRZELEW ŚRODKÓW\s+/i, '')
    .replace(/^TRANSAKCJA KARTĄ\s+/i, '')
    .replace(/\s+PL\s*$/i, '')
    .trim();

  if (cleaned.length > 35) {
    cleaned = cleaned.substring(0, 32) + '...';
  }

  return { merchant: cleaned || 'Uncategorized', category: 'Other' };
}

export function isInternalTransfer(description: string, creditorName?: string): boolean {
  const combined = `${creditorName || ''} ${description || ''}`.toLowerCase();
  
  const internalKeywords = [
    'przelew własny',
    'przelew na rachunek własny',
    'przelew miedzy rachunkami',
    'przelew między rachunkami',
    'zasilenie revolut',
    'revolut top up',
    'revolut top-up',
    'top-up revolut',
    'spłata karty',
    'splata karty',
    'lokata',
    'przelew na konto oszczędnościowe',
    'przelew z konta oszczędnościowego',
  ];

  return internalKeywords.some(k => combined.includes(k));
}

export function analyzeSpending(transactions: CleanTransaction[], period: string, daysInPeriod: number): SpendingAnalysis {
  let totalSpent = 0;
  let totalIncome = 0;
  const merchantMap = new Map<string, { category: string; amount: number; count: number }>();
  const categoryMap: Record<string, number> = {};
  const internalTransfers: Array<{ merchant: string; amount: number; date: string }> = [];
  const spentTransactions: CleanTransaction[] = [];

  for (const tx of transactions) {
    if (tx.is_internal_transfer) {
      internalTransfers.push({ merchant: tx.merchant, amount: Math.abs(tx.amount), date: tx.date });
      continue;
    }

    if (tx.is_income || tx.amount > 0) {
      totalIncome += tx.amount;
      continue;
    }

    const absAmount = Math.abs(tx.amount);
    totalSpent += absAmount;
    spentTransactions.push({ ...tx, amount: absAmount });

    const existing = merchantMap.get(tx.merchant) || { category: tx.category, amount: 0, count: 0 };
    existing.amount += absAmount;
    existing.count += 1;
    merchantMap.set(tx.merchant, existing);

    categoryMap[tx.category] = (categoryMap[tx.category] || 0) + absAmount;
  }

  const topMerchants = Array.from(merchantMap.entries())
    .map(([merchant, data]) => ({ merchant, ...data, amount: Math.round(data.amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  const amounts = spentTransactions.map(t => t.amount);
  const mean = amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
  const variance = amounts.length > 1 ? amounts.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (amounts.length - 1) : 0;
  const stdDev = Math.sqrt(variance);

  // Outlier detection: z-score or > 2.5x mean or > 3x median for significant expenses
  const sortedAmounts = [...amounts].sort((a, b) => a - b);
  const median = sortedAmounts.length > 0 ? sortedAmounts[Math.floor(sortedAmounts.length / 2)] : 0;
  const amountsExcludingMax = sortedAmounts.slice(0, -1);
  const baselineMean = amountsExcludingMax.length > 0 ? amountsExcludingMax.reduce((a, b) => a + b, 0) / amountsExcludingMax.length : mean;

  const outliers: CleanTransaction[] = [];
  for (const tx of spentTransactions) {
    const isOutlier =
      (stdDev > 0 && tx.amount > mean + 1.5 * stdDev) ||
      (baselineMean > 0 && tx.amount > 3 * baselineMean && tx.amount >= 200) ||
      (median > 0 && tx.amount > 3 * median && tx.amount >= 200);

    if (isOutlier) {
      const times = baselineMean > 0 ? (tx.amount / baselineMean).toFixed(1) : '2+';
      outliers.push({
        ...tx,
        is_outlier: true,
        outlier_reason: `${times}x above typical transaction size (${(baselineMean || median).toFixed(0)} PLN)`,
      });
    }
  }

  for (const cat in categoryMap) {
    categoryMap[cat] = Math.round(categoryMap[cat] * 100) / 100;
  }

  const safeDays = Math.max(daysInPeriod, 1);
  const dailyBurn = Math.round((totalSpent / safeDays) * 100) / 100;

  const dates = transactions.map(t => t.date).filter(Boolean).sort();
  const dateFrom = dates[0] || new Date().toISOString().slice(0, 10);
  const dateTo = dates[dates.length - 1] || new Date().toISOString().slice(0, 10);

  const byOwner: Record<string, { total_spent_pln: number; transaction_count: number }> = {};
  for (const tx of spentTransactions) {
    if (tx.owner) {
      if (!byOwner[tx.owner]) byOwner[tx.owner] = { total_spent_pln: 0, transaction_count: 0 };
      byOwner[tx.owner].total_spent_pln = Math.round((byOwner[tx.owner].total_spent_pln + Math.abs(tx.amount)) * 100) / 100;
      byOwner[tx.owner].transaction_count += 1;
    }
  }

  return {
    period,
    date_from: dateFrom,
    date_to: dateTo,
    total_spent_pln: Math.round(totalSpent * 100) / 100,
    total_income_pln: Math.round(totalIncome * 100) / 100,
    daily_burn_rate_pln: dailyBurn,
    transaction_count: spentTransactions.length,
    top_merchants: topMerchants,
    categories_breakdown: categoryMap,
    by_owner: Object.keys(byOwner).length > 0 ? byOwner : undefined,
    outliers,
    internal_transfers_excluded: internalTransfers,
  };
}

export function detectSubscriptions(transactions: CleanTransaction[]): SubscriptionItem[] {
  const byMerchant = new Map<string, Array<{ amount: number; date: string; category: string; owner?: string }>>();

  for (const tx of transactions) {
    if (tx.is_internal_transfer || tx.is_income || tx.amount >= 0) continue;
    const abs = Math.abs(tx.amount);
    const list = byMerchant.get(tx.merchant) || [];
    list.push({ amount: abs, date: tx.date, category: tx.category, owner: tx.owner });
    byMerchant.set(tx.merchant, list);
  }

  const subscriptions: SubscriptionItem[] = [];

  for (const [merchant, history] of byMerchant.entries()) {
    const isKnownSub = history.some(h => h.category === 'Subscriptions' || h.category === 'Utilities');

    if (history.length >= 2 || isKnownSub) {
      history.sort((a, b) => b.date.localeCompare(a.date));
      const latest = history[0];
      const avgAmount = history.reduce((sum, h) => sum + h.amount, 0) / history.length;
      const isConsistent = history.every(h => Math.abs(h.amount - avgAmount) / avgAmount < 0.25);

      if (isConsistent || isKnownSub) {
        subscriptions.push({
          merchant,
          category: latest.category,
          monthly_amount: Math.round(latest.amount * 100) / 100,
          occurrences: history.length,
          last_date: latest.date,
          frequency: 'monthly',
          owner: latest.owner,
        });
      }
    }
  }

  return subscriptions.sort((a, b) => b.monthly_amount - a.monthly_amount);
}

export function calculateCashflowForecast(
  liquidBalancePln: number,
  spentSoFarPln: number,
  recurringSubscriptions: SubscriptionItem[],
  dayOfMonth: number = new Date().getDate(),
  daysInMonth: number = 30,
): CashflowForecast {
  const daysRemaining = Math.max(daysInMonth - dayOfMonth, 1);
  const dailyBurn = dayOfMonth > 0 ? spentSoFarPln / dayOfMonth : 0;

  const monthlyFixedTotal = recurringSubscriptions.reduce((acc, sub) => acc + sub.monthly_amount, 0);
  const estimatedUpcomingBills = Math.max(monthlyFixedTotal * (daysRemaining / daysInMonth), 0);

  const projectedSpendRemaining = (dailyBurn * daysRemaining) + estimatedUpcomingBills;
  const projectedMonthEndBalance = liquidBalancePln - projectedSpendRemaining;

  const safeDailySpend = Math.max((liquidBalancePln - estimatedUpcomingBills) / daysRemaining, 0);

  let status: 'on_track' | 'warning' | 'deficit_risk' = 'on_track';
  let advice = '';

  if (projectedMonthEndBalance < 0) {
    status = 'deficit_risk';
    advice = `Warning: At your current pace of ${dailyBurn.toFixed(0)} PLN/day, you will exceed your balance before month end. Limit discretionary spending to ${safeDailySpend.toFixed(0)} PLN/day.`;
  } else if (projectedMonthEndBalance < liquidBalancePln * 0.15) {
    status = 'warning';
    advice = `Caution: Balance will be tight (${projectedMonthEndBalance.toFixed(0)} PLN left at month end). Target daily spend: ${safeDailySpend.toFixed(0)} PLN/day.`;
  } else {
    status = 'on_track';
    advice = `Looking healthy: Projected month-end balance is ${projectedMonthEndBalance.toFixed(0)} PLN. Safe daily spending limit: ${safeDailySpend.toFixed(0)} PLN/day.`;
  }

  return {
    current_liquid_balance_pln: Math.round(liquidBalancePln * 100) / 100,
    days_in_month: daysInMonth,
    day_of_month: dayOfMonth,
    days_remaining: daysRemaining,
    spent_so_far_pln: Math.round(spentSoFarPln * 100) / 100,
    current_daily_burn_rate_pln: Math.round(dailyBurn * 100) / 100,
    estimated_upcoming_recurring_pln: Math.round(estimatedUpcomingBills * 100) / 100,
    projected_month_end_balance_pln: Math.round(projectedMonthEndBalance * 100) / 100,
    safe_daily_spend_limit_pln: Math.round(safeDailySpend * 100) / 100,
    status,
    advice,
  };
}

export interface HarmfulTransactionAssessment {
  isHarmful: boolean;
  type: 'food_delivery' | 'bnpl_deferred' | 'impulse_shopping' | 'bank_fee' | 'none';
  reason: string;
  countermeasure: string;
  timeEstimate: string;
}

export interface DebtTransactionAssessment {
  isDebtRelated: boolean;
  type: 'bnpl_new_debt' | 'bnpl_installment' | 'credit_card_repayment' | 'credit_card_charge' | 'none';
  provider: string;
}

export function classifyDebtTransaction(tx: CleanTransaction): DebtTransactionAssessment {
  const desc = `${tx.merchant} ${tx.raw_description}`.toLowerCase();
  const isRepaymentKeyword =
    desc.includes('spłata') ||
    desc.includes('splata') ||
    desc.includes('repayment') ||
    desc.includes('rata') ||
    desc.includes('spłata zadłużenia') ||
    desc.includes('splata zadluzenia') ||
    desc.includes('spłata kredytu') ||
    desc.includes('splata kredytu');

  // 1. Credit Card Repayments (transfer or payment to pay down card/credit line)
  if (desc.includes('spłata karty') || desc.includes('splata karty') || (desc.includes('karta kredytowa') && isRepaymentKeyword)) {
    return { isDebtRelated: true, type: 'credit_card_repayment', provider: 'Karta Kredytowa' };
  }

  // 2. PayPo (Buy vs Installment Repayment)
  if (desc.includes('paypo')) {
    return { isDebtRelated: true, type: isRepaymentKeyword ? 'bnpl_installment' : 'bnpl_new_debt', provider: 'PayPo' };
  }

  // 3. Allegro Pay (Buy vs Installment Repayment)
  if (desc.includes('allegro pay')) {
    return { isDebtRelated: true, type: isRepaymentKeyword ? 'bnpl_installment' : 'bnpl_new_debt', provider: 'Allegro Pay' };
  }

  // 4. Twisto
  if (desc.includes('twisto')) {
    return { isDebtRelated: true, type: isRepaymentKeyword ? 'bnpl_installment' : 'bnpl_new_debt', provider: 'Twisto' };
  }

  // 5. Klarna
  if (desc.includes('klarna')) {
    return { isDebtRelated: true, type: isRepaymentKeyword ? 'bnpl_installment' : 'bnpl_new_debt', provider: 'Klarna' };
  }

  // 6. Revolut Pay Later
  if (desc.includes('revolut pay later')) {
    return { isDebtRelated: true, type: isRepaymentKeyword ? 'bnpl_installment' : 'bnpl_new_debt', provider: 'Revolut Pay Later' };
  }

  // 7. Loan / credit installment transfer
  if (isRepaymentKeyword && (desc.includes('kredyt') || desc.includes('pożyczka') || desc.includes('pozyczka'))) {
    return { isDebtRelated: true, type: 'credit_card_repayment', provider: 'Kredyt / Pożyczka' };
  }

  // 8. Purchases made directly on a credit card / credit facility account
  if (tx.is_credit_account && tx.amount < 0 && !tx.is_internal_transfer) {
    return { isDebtRelated: true, type: 'credit_card_charge', provider: `${tx.bank} (Karta Kredytowa)` };
  }

  return { isDebtRelated: false, type: 'none', provider: '' };
}

export function classifyHarmfulTransaction(tx: CleanTransaction): HarmfulTransactionAssessment {
  if (tx.is_internal_transfer || tx.is_income || tx.amount >= 0) {
    return { isHarmful: false, type: 'none', reason: '', countermeasure: '', timeEstimate: '' };
  }

  const desc = `${tx.merchant} ${tx.raw_description}`.toLowerCase();
  const absAmount = Math.abs(tx.amount);

  // 1. Food delivery apps (Pyszne.pl, Glovo takeaway, Uber Eats, Bolt Food)
  // Note: Wolt is used for groceries with Wolt+ free delivery plan, so it is treated as Groceries.
  if (desc.includes('pyszne') || desc.includes('uber eats') || desc.includes('bolt food')) {
    return {
      isHarmful: true,
      type: 'food_delivery',
      reason: `Wysoka marża dostawy jedzenia z restauracji (+30-40% względem gotowania). Wyczerpuje dzienny bufor.`,
      countermeasure: `Usuń zapisaną kartę z aplikacji dostawczej, aby dodać tarcie przed zamówieniem.`,
      timeEstimate: `1 min`,
    };
  }

  // 2. BNPL / Pay Later creation (accumulating deferred debt)
  const debt = classifyDebtTransaction(tx);
  if (debt.isDebtRelated && debt.type === 'bnpl_new_debt') {
    return {
      isHarmful: true,
      type: 'bnpl_deferred',
      reason: `Nowy odroczony dług w ${debt.provider}. Przesuwa koszty na kolejny miesiąc i maskuje stan konta.`,
      countermeasure: `Wyłącz '${debt.provider}' jako domyślną metodę w kasie sklepu.`,
      timeEstimate: `2 min`,
    };
  }

  // 3. Bank fees, overdraft interest, or cash advance fees
  if (desc.includes('odsetki') || desc.includes('prowizja bankowa') || desc.includes('opłata za prowadzenie') || desc.includes('prowizja za wypłatę')) {
    return {
      isHarmful: true,
      type: 'bank_fee',
      reason: `Prowizja bankowa lub karne odsetki (${absAmount.toFixed(2)} PLN). Czysty wyciek bez żadnej wartości.`,
      countermeasure: `Uzupełnij minimalne saldo na koncie lub zmień sposób wypłaty z bankomatów.`,
      timeEstimate: `2 min`,
    };
  }

  // 4. Large impulse online shopping (non-grocery, non-utility, > 250 PLN)
  const isEssentialCategory = ['Groceries', 'Utilities', 'Health & Beauty', 'Transport & Fuel'].includes(tx.category);
  if (!isEssentialCategory && absAmount >= 250 && !debt.isDebtRelated) {
    return {
      isHarmful: true,
      type: 'impulse_shopping',
      reason: `Duży nieplanowany zakup (${absAmount.toFixed(2)} PLN) w ${tx.merchant}.`,
      countermeasure: `Wprowadź regułę 24h: przenieś rzeczy do schowka/listy życzeń przed zakupem.`,
      timeEstimate: `1 min`,
    };
  }

  return { isHarmful: false, type: 'none', reason: '', countermeasure: '', timeEstimate: '' };
}

export function parseEnableBankingTransaction(
  tx: any,
  bankName: string,
  accountId: string,
  ownerName: string,
  fallbackDate: string,
): CleanTransaction {
  const rawAmountVal = parseFloat(tx.transaction_amount?.amount || '0');
  const indicator = tx.credit_debit_indicator;

  // In Open Banking (ISO 20022), DBIT = Debit (money spent, negative), CRDT = Credit (money received, positive)
  let amount = rawAmountVal;
  if (indicator === 'DBIT') {
    amount = -Math.abs(rawAmountVal);
  } else if (indicator === 'CRDT') {
    amount = Math.abs(rawAmountVal);
  }

  const isIncome = indicator ? indicator === 'CRDT' : amount > 0;

  // Extract merchant / creditor / debtor names
  const creditorName = tx.creditor?.name || tx.creditor_name || '';
  const debtorName = tx.debtor?.name || tx.debtor_name || '';
  let desc = '';
  if (Array.isArray(tx.remittance_information) && tx.remittance_information.length > 0) {
    desc = tx.remittance_information.filter(Boolean).join(' ').trim();
  } else if (tx.remittance_information_unstructured) {
    desc = String(tx.remittance_information_unstructured).trim();
  }

  if (!desc) {
    desc = isIncome ? debtorName || creditorName : creditorName || debtorName;
  }

  const norm = cleanMerchantAndCategory(desc, isIncome ? debtorName || creditorName : creditorName);
  const isInternal = isInternalTransfer(desc, creditorName || debtorName);
  const txDate = tx.booking_date || tx.value_date || fallbackDate;

  return {
    id: tx.entry_reference || tx.transaction_id || `${accountId}-${txDate}-${Math.abs(amount)}`,
    bank: bankName,
    account_id: accountId,
    owner: ownerName,
    date: txDate,
    amount,
    currency: tx.transaction_amount?.currency || 'PLN',
    merchant: norm.merchant,
    category: norm.category,
    raw_description: desc,
    is_internal_transfer: isInternal,
    is_income: isIncome,
  };
}
