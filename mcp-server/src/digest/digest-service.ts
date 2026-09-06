import pino from 'pino';
import { EnableBankingClient, EnableBankingBalance, EnableBankingTransaction } from '../enable-banking/client.js';
import { SessionStore } from '../enable-banking/session-store.js';
import {
  CleanTransaction,
  detectSubscriptions,
  calculateCashflowForecast,
  classifyHarmfulTransaction,
  classifyDebtTransaction,
  parseEnableBankingTransaction,
} from '../analysis/polish-finance.js';
import { ImprovementPlanStore } from './plan-store.js';
import { formatAdhdDigest, ExpectedExpenseItem, DigestAnalysisResult, FormattedDigest } from './adhd-formatter.js';
import { EmailSender } from './email-sender.js';
import { Config } from '../config.js';

const logger = pino({ name: 'digest-service' });

export class DigestService {
  private ebClient?: EnableBankingClient;
  private sessionStore: SessionStore;
  private planStore: ImprovementPlanStore;
  private emailSender: EmailSender;
  private config: Config;

  constructor(
    sessionStore: SessionStore,
    planStore: ImprovementPlanStore,
    emailSender: EmailSender,
    config: Config,
    ebClient?: EnableBankingClient,
  ) {
    this.sessionStore = sessionStore;
    this.planStore = planStore;
    this.emailSender = emailSender;
    this.config = config;
    this.ebClient = ebClient;
  }

  setEbClient(client: EnableBankingClient): void {
    this.ebClient = client;
  }

  async runDailyDigest(options: { dryRun?: boolean; forceDate?: string } = {}): Promise<{
    analysis: DigestAnalysisResult;
    formatted: FormattedDigest;
    emailResult?: { success: boolean; messageId?: string; error?: string };
  }> {
    const todayStr = options.forceDate || new Date().toISOString().slice(0, 10);
    logger.info({ today: todayStr, dryRun: options.dryRun }, 'starting_daily_digest_run');

    const connections = this.sessionStore.getAllBankConnections();
    const allTodayTxs: CleanTransaction[] = [];
    const allPastTxs: CleanTransaction[] = [];
    let totalLiquidPln = 0;
    let totalCreditDebtPln = 0;
    const foreignBalances: Array<{ currency: string; amount: number }> = [];

    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);

    // 1. Fetch Balances & Transactions from Enable Banking (with database cache fallback for PSD2 rate limits)
    if (this.ebClient) {
      const creditAccountIds = new Set<string>();

      for (const conn of connections) {
        for (const accountId of conn.account_uids) {
          // Balances
          let balances: EnableBankingBalance[] | null = null;
          try {
            balances = await this.ebClient.getBalances(accountId);
            this.sessionStore.saveAccountBalances(accountId, balances);
          } catch (err) {
            logger.warn({ accountId, err }, 'failed_to_fetch_balances_from_bank_trying_cache');
            balances = (this.sessionStore.getAccountBalances(accountId) as EnableBankingBalance[]) || null;
          }

          if (balances && balances.length > 0) {
            // Deduplicate: pick the single primary balance for this account
            // Priority: ITAV (Interim Available) > CLBD (Closing Booked) > ITBD (Interim Booked) > first
            const primary = balances.find(b => b.balance_type === 'ITAV')
              || balances.find(b => b.balance_type === 'CLBD')
              || balances.find(b => b.balance_type === 'ITBD')
              || balances[0];

            const amt = parseFloat(primary.balance_amount.amount);
            const curr = primary.balance_amount.currency;

            if (curr === 'PLN') {
              if (amt >= 0) {
                totalLiquidPln += amt;
              } else {
                totalCreditDebtPln += Math.abs(amt);
                creditAccountIds.add(accountId);
              }
            } else {
              foreignBalances.push({ currency: curr, amount: amt });
            }
          }

          // Transactions
          let rawTxs: EnableBankingTransaction[] | null = null;
          try {
            rawTxs = await this.ebClient.getTransactions(accountId, sixtyDaysAgo, todayStr);
            this.sessionStore.saveAccountTransactions(accountId, rawTxs);
          } catch (err) {
            logger.warn({ accountId, err }, 'failed_to_fetch_transactions_from_bank_trying_cache');
            rawTxs = (this.sessionStore.getAccountTransactions(accountId) as EnableBankingTransaction[]) || null;
          }

          if (rawTxs) {
            for (const tx of rawTxs) {
              const cleanTx = parseEnableBankingTransaction(
                tx,
                conn.aspsp_name,
                accountId,
                conn.owner_name,
                todayStr,
              );
              cleanTx.is_credit_account = creditAccountIds.has(accountId);

              allPastTxs.push(cleanTx);
              if (cleanTx.date === todayStr) {
                allTodayTxs.push(cleanTx);
              }
            }
          }
        }
      }
    }

    // 2. Classify today's transactions
    let totalSpentTodayPln = 0;
    let totalIncomeTodayPln = 0;
    const internalTransfersExcluded: Array<{ merchant: string; amount: number }> = [];
    const harmfulTransactions: Array<{
      transaction: CleanTransaction;
      reason: string;
      countermeasure: string;
      timeEstimate: string;
    }> = [];
    const debtTransactions: Array<{
      transaction: CleanTransaction;
      type: 'bnpl_new_debt' | 'bnpl_installment' | 'credit_card_repayment' | 'credit_card_charge';
      provider: string;
    }> = [];

    for (const tx of allTodayTxs) {
      // Check for BNPL & Debt & Repayments FIRST (even if an internal transfer, e.g. spłata karty)
      const debtClass = classifyDebtTransaction(tx);
      if (debtClass.isDebtRelated && debtClass.type !== 'none') {
        debtTransactions.push({
          transaction: tx,
          type: debtClass.type,
          provider: debtClass.provider,
        });
      }

      // Internal transfers are excluded from consumption/burn spend
      if (tx.is_internal_transfer) {
        internalTransfersExcluded.push({ merchant: tx.merchant, amount: Math.abs(tx.amount) });
        continue;
      }

      if (tx.amount < 0) {
        totalSpentTodayPln += Math.abs(tx.amount);
      } else if (tx.amount > 0) {
        totalIncomeTodayPln += tx.amount;
      }

      // Check for Harmful / Impulse spending
      const harmfulClass = classifyHarmfulTransaction(tx);
      if (harmfulClass.isHarmful) {
        harmfulTransactions.push({
          transaction: tx,
          reason: harmfulClass.reason,
          countermeasure: harmfulClass.countermeasure,
          timeEstimate: harmfulClass.timeEstimate,
        });
      }
    }

    // 3. Forecast next week's expected bills based on history
    const detectedSubs = detectSubscriptions(allPastTxs);
    const now = new Date();
    const currentDayOfMonth = now.getDate();
    const upcomingExpenses: ExpectedExpenseItem[] = [];
    let expectedUpcomingWeekPln = 0;

    for (const sub of detectedSubs) {
      const subDate = new Date(sub.last_date);
      const subDay = subDate.getDate() || 1;
      
      let daysUntil = subDay - currentDayOfMonth;
      if (daysUntil < 0) {
        daysUntil += 30;
      }

      if (daysUntil >= 0 && daysUntil <= 7) {
        const expectedDate = new Date(now.getTime() + daysUntil * 24 * 3600 * 1000).toISOString().slice(0, 10);
        upcomingExpenses.push({
          name: sub.merchant,
          category: sub.category,
          expectedDate,
          amountPln: sub.monthly_amount,
          type: sub.category === 'Utilities' ? 'invoice' : 'subscription',
        });
        expectedUpcomingWeekPln += sub.monthly_amount;
      }
    }

    // Baseline grocery / daily living estimate (~350 PLN/week)
    const baselineGroceries = 350;
    expectedUpcomingWeekPln += baselineGroceries;

    // 4. Calculate safe daily spend based on positive liquid cash
    const cashflow = calculateCashflowForecast(totalLiquidPln, totalSpentTodayPln, detectedSubs, currentDayOfMonth, 30);
    const safeDailySpendPln = cashflow.safe_daily_spend_limit_pln;

    // 5. Update Plan Memory in SQLite
    let winMessage = '';
    const updatedPlan = this.planStore.updatePlan(state => {
      const isHarmfulFree = harmfulTransactions.length === 0 && !debtTransactions.some(d => d.type === 'bnpl_new_debt');

      if (isHarmfulFree) {
        state.habits_tracker.consecutive_days_without_harmful_spend += 1;
        state.debt_tracker.consecutive_days_without_new_bnpl += 1;
      } else {
        state.habits_tracker.consecutive_days_without_harmful_spend = 0;
      }

      // Check for debt repayments today
      const repaymentsToday = debtTransactions.filter(d => d.type === 'bnpl_installment' || d.type === 'credit_card_repayment');
      if (repaymentsToday.length > 0) {
        const repSum = repaymentsToday.reduce((sum, d) => sum + Math.abs(d.transaction.amount), 0);
        state.debt_tracker.total_debt_repayments_logged_pln += repSum;
        state.debt_tracker.last_repayment_date = todayStr;
        winMessage = `Zarejestrowano spłatę długu! Wpłacono ${repSum.toFixed(2)} PLN na poczet odroczonych zobowiązań.`;
        state.habits_tracker.logged_wins.push({ date: todayStr, win: winMessage });
      } else if (totalIncomeTodayPln > 0 && isHarmfulFree) {
        winMessage = `Wpływ na konto (+${totalIncomeTodayPln.toFixed(2)} PLN) i brak szkodliwych wydatków dzisiaj!`;
        state.habits_tracker.logged_wins.push({ date: todayStr, win: winMessage });
      } else if (isHarmfulFree && allTodayTxs.length > 0) {
        winMessage = `Czysty dzień bez zakupów na raty ani impulsów. Bezpieczny bufor ochroniony!`;
        state.habits_tracker.logged_wins.push({ date: todayStr, win: winMessage });
      }

      // Step progression logic:
      // Step 1 -> Step 2 when 7 consecutive days clean of BNPL
      if (state.current_step === 1 && state.debt_tracker.consecutive_days_without_new_bnpl >= 7) {
        state.steps[0].status = 'completed';
        state.steps[0].completed_at = todayStr;
        state.current_step = 2;
        winMessage = `SUKCES ETAPU: Krok 1 zakończony! 7 dni bez nowego długu BNPL. Rozpoczynamy Krok 2 (Bufor 1 000 PLN).`;
        state.habits_tracker.logged_wins.push({ date: todayStr, win: winMessage });
      } else if (state.current_step === 2 && totalLiquidPln >= 1000) {
        state.steps[1].status = 'completed';
        state.steps[1].completed_at = todayStr;
        state.current_step = 3;
        winMessage = `SUKCES ETAPU: Krok 2 zakończony! Zgromadzono bufor 1 000 PLN. Przechodzimy do Kroku 3 (Kula Śnieżna).`;
        state.habits_tracker.logged_wins.push({ date: todayStr, win: winMessage });
      }

      state.total_savings_buffer_pln = totalLiquidPln;
      state.last_digest_at = Date.now();
      state.last_digest_date = todayStr;

      state.history.push({
        date: todayStr,
        step_number: state.current_step,
        harmful_count: harmfulTransactions.length,
        total_spent_today_pln: totalSpentTodayPln,
        summary: winMessage || `${harmfulTransactions.length} wycieków, ${totalSpentTodayPln.toFixed(0)} PLN wydatków`,
      });

      return state;
    });

    // 6. Format digest email adhering to i-have-adhd
    const analysis: DigestAnalysisResult = {
      date: todayStr,
      todayTransactions: allTodayTxs,
      totalSpentTodayPln: Math.round(totalSpentTodayPln * 100) / 100,
      totalIncomeTodayPln: Math.round(totalIncomeTodayPln * 100) / 100,
      internalTransfersExcluded,
      harmfulTransactions,
      debtTransactions,
      upcomingExpenses: upcomingExpenses.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate)),
      totalUpcomingWeekPln: expectedUpcomingWeekPln,
      safeDailySpendPln,
      liquidBalancePln: Math.round(totalLiquidPln * 100) / 100,
      creditDebtPln: Math.round(totalCreditDebtPln * 100) / 100,
      netBalancePln: Math.round((totalLiquidPln - totalCreditDebtPln) * 100) / 100,
      foreignBalances,
      winMessage,
    };

    const formatted = formatAdhdDigest(analysis, updatedPlan);

    // 7. Dispatch Email
    let emailResult: { success: boolean; messageId?: string; error?: string } | undefined;
    if (!options.dryRun) {
      emailResult = await this.emailSender.send({
        to: this.config.emailRecipients,
        subject: formatted.subject,
        text: formatted.text,
        html: formatted.html,
      });
      logger.info({ emailResult }, 'digest_email_dispatched');
    }

    return {
      analysis,
      formatted,
      emailResult,
    };
  }
}
