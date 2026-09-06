import pino from 'pino';
import { EnableBankingClient } from '../enable-banking/client.js';
import { SessionStore } from '../enable-banking/session-store.js';
import {
  CleanTransaction,
  cleanMerchantAndCategory,
  isInternalTransfer,
  detectSubscriptions,
  calculateCashflowForecast,
  classifyHarmfulTransaction,
  classifyDebtTransaction,
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

    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);

    // 1. Fetch Balances & Transactions from Enable Banking
    if (this.ebClient) {
      for (const conn of connections) {
        for (const accountId of conn.account_uids) {
          // Balances
          try {
            const balances = await this.ebClient.getBalances(accountId);
            for (const b of balances) {
              if (b.balance_amount.currency === 'PLN') {
                totalLiquidPln += parseFloat(b.balance_amount.amount);
              }
            }
          } catch (err) {
            logger.warn({ accountId, err }, 'failed_to_fetch_balance_for_account');
          }

          // Transactions
          try {
            const rawTxs = await this.ebClient.getTransactions(accountId, sixtyDaysAgo, todayStr);
            for (const tx of rawTxs) {
              const rawAmount = parseFloat(tx.transaction_amount.amount);
              const desc = tx.remittance_information_unstructured || '';
              const cred = tx.creditor_name || '';
              const norm = cleanMerchantAndCategory(desc, cred);
              const isInternal = isInternalTransfer(desc, cred);
              const txDate = tx.booking_date || tx.value_date || todayStr;

              const cleanTx: CleanTransaction = {
                id: tx.entry_reference || tx.transaction_id || `${accountId}-${desc.slice(0, 10)}`,
                bank: conn.aspsp_name,
                account_id: accountId,
                owner: conn.owner_name,
                date: txDate,
                amount: rawAmount,
                currency: tx.transaction_amount.currency,
                merchant: norm.merchant,
                category: norm.category,
                raw_description: desc,
                is_internal_transfer: isInternal,
                is_income: rawAmount > 0,
              };

              allPastTxs.push(cleanTx);
              if (txDate === todayStr) {
                allTodayTxs.push(cleanTx);
              }
            }
          } catch (err) {
            logger.warn({ accountId, err }, 'failed_to_fetch_transactions_for_account');
          }
        }
      }
    }

    // 2. Classify today's transactions
    let totalSpentTodayPln = 0;
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
      if (tx.is_internal_transfer) {
        internalTransfersExcluded.push({ merchant: tx.merchant, amount: Math.abs(tx.amount) });
        continue;
      }

      if (tx.amount < 0) {
        totalSpentTodayPln += Math.abs(tx.amount);
      }

      // Check for BNPL & Debt
      const debtClass = classifyDebtTransaction(tx);
      if (debtClass.isDebtRelated && debtClass.type !== 'none') {
        debtTransactions.push({
          transaction: tx,
          type: debtClass.type,
          provider: debtClass.provider,
        });
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

    // 3. Forecast next week's expected bills based on 60-day history
    const detectedSubs = detectSubscriptions(allPastTxs);
    const now = new Date();
    const currentDayOfMonth = now.getDate();
    const upcomingExpenses: ExpectedExpenseItem[] = [];
    let expectedUpcomingWeekPln = 0;

    for (const sub of detectedSubs) {
      // Parse sub day of month from last_date
      const subDate = new Date(sub.last_date);
      const subDay = subDate.getDate() || 1;
      
      // Check if sub falls within next 7 days
      let daysUntil = subDay - currentDayOfMonth;
      if (daysUntil < 0) {
        daysUntil += 30; // wraps into next month
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

    // Add baseline grocery / daily living estimate (~350 PLN/week)
    const baselineGroceries = 350;
    expectedUpcomingWeekPln += baselineGroceries;

    // 4. Calculate safe daily spend
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
        winMessage = `Debt payoff logged! Paid ${repSum.toFixed(2)} PLN towards deferred debt today.`;
        state.habits_tracker.logged_wins.push({ date: todayStr, win: winMessage });
      } else if (isHarmfulFree && allTodayTxs.length > 0) {
        winMessage = `Zero harmful or deferred-debt transactions today. Safe buffer protected!`;
        state.habits_tracker.logged_wins.push({ date: todayStr, win: winMessage });
      }

      // Step progression logic:
      // Step 1 -> Step 2 when 7 consecutive days clean of BNPL
      if (state.current_step === 1 && state.debt_tracker.consecutive_days_without_new_bnpl >= 7) {
        state.steps[0].status = 'completed';
        state.steps[0].completed_at = todayStr;
        state.current_step = 2;
        winMessage = `MILESTONE UNLOCKED: Step 1 Complete! 7 days free of new BNPL. Starting Step 2 (1,000 PLN Buffer).`;
        state.habits_tracker.logged_wins.push({ date: todayStr, win: winMessage });
      } else if (state.current_step === 2 && totalLiquidPln >= 1000) {
        state.steps[1].status = 'completed';
        state.steps[1].completed_at = todayStr;
        state.current_step = 3;
        winMessage = `MILESTONE UNLOCKED: Step 2 Complete! 1,000 PLN buffer reached. Advancing to Step 3 (Debt Snowball).`;
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
        summary: winMessage || `${harmfulTransactions.length} leaks, ${totalSpentTodayPln.toFixed(0)} PLN spent`,
      });

      return state;
    });

    // 6. Format digest email adhering to i-have-adhd
    const analysis: DigestAnalysisResult = {
      date: todayStr,
      todayTransactions: allTodayTxs,
      totalSpentTodayPln,
      internalTransfersExcluded,
      harmfulTransactions,
      debtTransactions,
      upcomingExpenses: upcomingExpenses.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate)),
      totalUpcomingWeekPln: expectedUpcomingWeekPln,
      safeDailySpendPln,
      liquidBalancePln: totalLiquidPln,
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
