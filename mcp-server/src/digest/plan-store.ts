import Database from 'better-sqlite3';
import pino from 'pino';

const logger = pino({ name: 'plan-store' });

export interface ImprovementPlanStep {
  step_number: number;
  title: string;
  focus: string;
  target_goal: string;
  status: 'active' | 'completed';
  completed_at?: string;
}

export interface ImprovementPlanState {
  current_step: number;
  steps: ImprovementPlanStep[];
  debt_tracker: {
    bnpl_providers_detected: string[];
    estimated_monthly_bnpl_repayments_pln: number;
    consecutive_days_without_new_bnpl: number;
    total_debt_repayments_logged_pln: number;
    last_repayment_date?: string;
  };
  habits_tracker: {
    consecutive_days_without_harmful_spend: number;
    total_delivery_spend_this_month_pln: number;
    total_impulse_prevented_pln: number;
    logged_wins: Array<{ date: string; win: string }>;
  };
  total_savings_buffer_pln: number;
  last_digest_at?: number;
  last_digest_date?: string;
  history: Array<{
    date: string;
    step_number: number;
    harmful_count: number;
    total_spent_today_pln: number;
    summary: string;
  }>;
}

export const DEFAULT_PLAN_STEPS: ImprovementPlanStep[] = [
  {
    step_number: 1,
    title: 'Freeze New BNPL & Pay-Later Debt',
    focus: 'Stop creating deferred debts via Allegro Pay, PayPo, Twisto, and Klarna',
    target_goal: '7 consecutive days with zero new buy-now-pay-later orders',
    status: 'active',
  },
  {
    step_number: 2,
    title: 'Build 1,000 PLN Emergency Micro-Buffer',
    focus: 'Liquid cash cushion in savings account',
    target_goal: 'Accumulate and hold 1,000 PLN in savings to stop borrowing for surprises',
    status: 'active',
  },
  {
    step_number: 3,
    title: 'Debt Snowball: Knock Out Smallest Deferred Balance',
    focus: 'Pay off PayPo / credit cards smallest to largest for fast dopamine wins',
    target_goal: '0 PLN outstanding balance across all buy-now-pay-later services',
    status: 'active',
  },
  {
    step_number: 4,
    title: 'Prune Recurring Leaks & Food Delivery',
    focus: 'Reduce food delivery apps (Pyszne/Glovo) and cancel unused subscriptions',
    target_goal: 'Keep delivery spend under 150 PLN/month & cancel 1 recurring leak',
    status: 'active',
  },
  {
    step_number: 5,
    title: 'Automate Payday Wealth Engine',
    focus: 'Set standing orders for savings & investments right after salary hits',
    target_goal: 'Recurring automatic monthly transfer to savings / investment accounts',
    status: 'active',
  },
];

export function createInitialPlanState(): ImprovementPlanState {
  return {
    current_step: 1,
    steps: JSON.parse(JSON.stringify(DEFAULT_PLAN_STEPS)),
    debt_tracker: {
      bnpl_providers_detected: [],
      estimated_monthly_bnpl_repayments_pln: 0,
      consecutive_days_without_new_bnpl: 0,
      total_debt_repayments_logged_pln: 0,
    },
    habits_tracker: {
      consecutive_days_without_harmful_spend: 0,
      total_delivery_spend_this_month_pln: 0,
      total_impulse_prevented_pln: 0,
      logged_wins: [],
    },
    total_savings_buffer_pln: 0,
    history: [],
  };
}

export class ImprovementPlanStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS adhd_improvement_plan (
        id TEXT PRIMARY KEY,
        current_step INTEGER NOT NULL DEFAULT 1,
        state_json TEXT NOT NULL,
        last_digest_at INTEGER,
        last_digest_date TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  getPlanState(planId: string = 'household_plan'): ImprovementPlanState {
    const row = this.db.prepare('SELECT state_json FROM adhd_improvement_plan WHERE id = ?').get(planId) as { state_json: string } | undefined;
    if (!row) {
      const initial = createInitialPlanState();
      this.savePlanState(initial, planId);
      return initial;
    }

    try {
      const parsed = JSON.parse(row.state_json) as ImprovementPlanState;
      // Ensure steps array is fully populated if new steps are added
      if (!parsed.steps || parsed.steps.length === 0) {
        parsed.steps = JSON.parse(JSON.stringify(DEFAULT_PLAN_STEPS));
      }
      return parsed;
    } catch (err) {
      logger.error({ err }, 'failed_to_parse_plan_state_json_resetting_to_default');
      const initial = createInitialPlanState();
      this.savePlanState(initial, planId);
      return initial;
    }
  }

  savePlanState(state: ImprovementPlanState, planId: string = 'household_plan'): void {
    const now = Date.now();
    const jsonStr = JSON.stringify(state);

    this.db.prepare(`
      INSERT INTO adhd_improvement_plan (id, current_step, state_json, last_digest_at, last_digest_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        current_step = excluded.current_step,
        state_json = excluded.state_json,
        last_digest_at = excluded.last_digest_at,
        last_digest_date = excluded.last_digest_date,
        updated_at = excluded.updated_at
    `).run(
      planId,
      state.current_step,
      jsonStr,
      state.last_digest_at || null,
      state.last_digest_date || null,
      now,
      now,
    );
  }

  updatePlan(updater: (state: ImprovementPlanState) => ImprovementPlanState, planId: string = 'household_plan'): ImprovementPlanState {
    const current = this.getPlanState(planId);
    const updated = updater(current);
    this.savePlanState(updated, planId);
    return updated;
  }
}
