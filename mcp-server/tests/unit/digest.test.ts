import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ImprovementPlanStore } from '../../src/digest/plan-store.js';
import { formatAdhdDigest, DigestAnalysisResult } from '../../src/digest/adhd-formatter.js';
import { EmailSender } from '../../src/digest/email-sender.js';
import { DigestService } from '../../src/digest/digest-service.js';
import { SessionStore } from '../../src/enable-banking/session-store.js';
import type { EnableBankingClient, EnableBankingBalance, EnableBankingTransaction } from '../../src/enable-banking/client.js';
import { getConfig } from '../../src/config.js';

describe('Daily ADHD Digest Service & Plan Memory', () => {
  let dbPath: string;
  let db: Database.Database;
  let planStore: ImprovementPlanStore;
  let sessionStore: SessionStore;

  beforeEach(() => {
    dbPath = `./data/test-digest-${randomUUID()}.db`;
    sessionStore = new SessionStore(dbPath);
    db = sessionStore.getDb();
    planStore = new ImprovementPlanStore(db);
  });

  afterEach(() => {
    sessionStore.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  describe('ImprovementPlanStore', () => {
    it('initializes with default 5-step roadmap and zero streaks', () => {
      const state = planStore.getPlanState();
      expect(state.current_step).toBe(1);
      expect(state.steps).toHaveLength(5);
      expect(state.steps[0].title).toContain('Freeze New BNPL');
      expect(state.steps[1].title).toContain('1,000 PLN');
      expect(state.habits_tracker.consecutive_days_without_harmful_spend).toBe(0);
      expect(state.debt_tracker.total_debt_repayments_logged_pln).toBe(0);
    });

    it('persists updates and tracks step progression', () => {
      planStore.updatePlan(state => {
        state.habits_tracker.consecutive_days_without_harmful_spend = 7;
        state.debt_tracker.consecutive_days_without_new_bnpl = 7;
        state.steps[0].status = 'completed';
        state.current_step = 2;
        return state;
      });

      const reloaded = planStore.getPlanState();
      expect(reloaded.current_step).toBe(2);
      expect(reloaded.steps[0].status).toBe('completed');
      expect(reloaded.habits_tracker.consecutive_days_without_harmful_spend).toBe(7);
    });
  });

  describe('ADHD Formatter (i-have-adhd Rules Compliance)', () => {
    it('formats email strictly following i-have-adhd rules', () => {
      const mockAnalysis: DigestAnalysisResult = {
        date: '2026-09-06',
        todayTransactions: [
          {
            id: 'tx-1',
            bank: 'PKO Bank Polski',
            account_id: 'acc-1',
            date: '2026-09-06',
            amount: -65.50,
            currency: 'PLN',
            merchant: 'Pyszne.pl',
            category: 'Dining',
            raw_description: 'PYSZNE.PL WARSZAWA',
            is_internal_transfer: false,
            is_income: false,
          },
        ],
        totalSpentTodayPln: 65.50,
        internalTransfersExcluded: [],
        harmfulTransactions: [
          {
            transaction: {
              id: 'tx-1',
              bank: 'PKO Bank Polski',
              account_id: 'acc-1',
              date: '2026-09-06',
              amount: -65.50,
              currency: 'PLN',
              merchant: 'Pyszne.pl',
              category: 'Dining',
              raw_description: 'PYSZNE.PL WARSZAWA',
              is_internal_transfer: false,
              is_income: false,
            },
            reason: 'Food delivery markup (+30-40% vs groceries/cooking). Drains daily spend buffer.',
            countermeasure: 'Delete saved card from delivery app now so ordering has friction.',
            timeEstimate: '1 min',
          },
        ],
        debtTransactions: [],
        upcomingExpenses: [
          {
            name: 'Netflix',
            category: 'Subscriptions',
            expectedDate: '2026-09-09',
            amountPln: 49.00,
            type: 'subscription',
          },
        ],
        totalUpcomingWeekPln: 399.00,
        safeDailySpendPln: 85.00,
        liquidBalancePln: 3250.00,
        winMessage: 'Zero BNPL orders created today (+streak preserved).',
      };

      const planState = planStore.getPlanState();
      const formatted = formatAdhdDigest(mockAnalysis, planState);

      // Rule 1: Lead with the next action (first line is ACTION NOW)
      expect(formatted.text.startsWith('ACTION NOW: Delete saved card from delivery app now so ordering has friction. (1 min)')).toBe(true);

      // Rule 5: Restate state every turn
      expect(formatted.text).toContain('STATE: Step 1 of 5: Freeze New BNPL & Pay-Later Debt');
      expect(formatted.text).toContain('Liquid Balance: 3250.00 PLN');

      // Rule 7: Make wins visible
      expect(formatted.text).toContain('✓ WIN TODAY: Zero BNPL orders created today');

      // Harmful transaction identified with actionable fix
      expect(formatted.text).toContain('Pyszne.pl (65.50 PLN): Food delivery markup');
      expect(formatted.text).toContain('-> Fix (1 min): Delete saved card from delivery app');

      // Next week forecast included
      expect(formatted.text).toContain('NEXT 7 DAYS EXPECTED EXPENSES');
      expect(formatted.text).toContain('Netflix — 49.00 PLN');
      expect(formatted.text).toContain('Safe daily spend allowance: 85 PLN/day.');

      // Rule 2: Number multi-step work (<= 3 steps)
      expect(formatted.text).toContain('NEXT ACTIONS FOR TONIGHT:');
      expect(formatted.text).toContain('1. Delete saved card');
      expect(formatted.text).toContain('2. Check your calendar');

      // Rule 3: End with ONE concrete next action under 2 minutes
      expect(formatted.text).toContain('NEXT (2 min): Complete step 1 right now and close this email.');

      // HTML version rendered
      expect(formatted.html).toContain('⚡ Action Now (Do First)');
      expect(formatted.html).toContain('Delete saved card');
    });
  });

  describe('DigestService Execution & Internal Transfer Deduplication', () => {
    it('executes full daily run, excludes internal transfers, and updates plan', async () => {
      // Seed bank connection
      sessionStore.saveBankConnection({
        id: 'pko_bp_jakub',
        bank_key: 'pko_bp',
        aspsp_name: 'PKO Bank Polski',
        aspsp_country: 'PL',
        session_id: 'pko-session-1',
        account_uids: ['acc-pko'],
        valid_until: '2026-12-01',
        owner_name: 'Jakub',
      });

      const mockBalances: Record<string, EnableBankingBalance[]> = {
        'acc-pko': [{ balance_amount: { amount: '4500.00', currency: 'PLN' }, balance_type: 'CLBD' }],
      };

      const mockTxs: Record<string, EnableBankingTransaction[]> = {
        'acc-pko': [
          // 1. Internal transfer: PKO -> Revolut (MUST be excluded from spend!)
          {
            transaction_id: 'tx-transfer',
            transaction_amount: { amount: '-400.00', currency: 'PLN' },
            booking_date: '2026-09-06',
            remittance_information_unstructured: 'PRZELEW WŁASNY ZASILENIE REVOLUT',
          },
          // 2. Normal grocery purchase
          {
            transaction_id: 'tx-groceries',
            transaction_amount: { amount: '-85.20', currency: 'PLN' },
            booking_date: '2026-09-06',
            remittance_information_unstructured: 'BIEDRONKA 1234 KRAKOW',
          },
          // 3. PayPo repayment (debt payoff!)
          {
            transaction_id: 'tx-paypo',
            transaction_amount: { amount: '-150.00', currency: 'PLN' },
            booking_date: '2026-09-06',
            remittance_information_unstructured: 'SPŁATA PAYPO ZLECENIE 9988',
          },
        ],
      };

      const mockEbClient: Partial<EnableBankingClient> = {
        getBalances: async (id: string) => mockBalances[id] || [],
        getTransactions: async (id: string) => mockTxs[id] || [],
      };

      const emailSender = new EmailSender({
        secretKey: '',
        projectId: 'test-project',
        senderEmail: 'budget@assistant.jakub.team',
      });

      const config = getConfig();
      const service = new DigestService(
        sessionStore,
        planStore,
        emailSender,
        config,
        mockEbClient as EnableBankingClient,
      );

      const result = await service.runDailyDigest({ forceDate: '2026-09-06' });

      // Internal transfer properly excluded
      expect(result.analysis.internalTransfersExcluded).toHaveLength(1);
      expect(result.analysis.internalTransfersExcluded[0].amount).toBe(400);

      // Total spent today excludes internal transfer (85.20 + 150 = 235.20)
      expect(result.analysis.totalSpentTodayPln).toBe(235.20);

      // Debt repayment recorded
      expect(result.analysis.debtTransactions).toHaveLength(1);
      expect(result.analysis.debtTransactions[0].type).toBe('bnpl_installment');

      // Email recorded in memory
      expect(emailSender.sentEmails).toHaveLength(1);
      expect(emailSender.sentEmails[0].to).toContain('sikora@jakub.team');
      expect(emailSender.sentEmails[0].to).toContain('arletarynk@gmail.com');

      // Plan memory updated with debt repayment and clean streak
      const updatedPlan = planStore.getPlanState();
      expect(updatedPlan.debt_tracker.total_debt_repayments_logged_pln).toBe(150);
      expect(updatedPlan.last_digest_date).toBe('2026-09-06');
      expect(updatedPlan.history).toHaveLength(1);
    });
  });
});
