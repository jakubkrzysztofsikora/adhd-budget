import pino from 'pino';
import { DigestService } from './digest-service.js';
import { ImprovementPlanStore } from './plan-store.js';

const logger = pino({ name: 'digest-scheduler' });

export class DigestScheduler {
  private digestService: DigestService;
  private planStore: ImprovementPlanStore;
  private targetHour: number;
  private timer?: NodeJS.Timeout;
  private isRunning: boolean = false;

  constructor(
    digestService: DigestService,
    planStore: ImprovementPlanStore,
    targetHour: number = 21, // 21:00 Warsaw time
  ) {
    this.digestService = digestService;
    this.planStore = planStore;
    this.targetHour = targetHour;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info({ targetHour: this.targetHour }, 'digest_scheduler_started');

    // Check every 5 minutes
    this.timer = setInterval(() => {
      this.checkAndRun();
    }, 5 * 60 * 1000);

    // Also run an initial check
    this.checkAndRun();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.isRunning = false;
    logger.info('digest_scheduler_stopped');
  }

  private async checkAndRun(): Promise<void> {
    try {
      // Get current date and hour in Europe/Warsaw timezone
      const now = new Date();
      const warsawTimeStr = now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' });
      const warsawDate = new Date(warsawTimeStr);
      const currentHour = warsawDate.getHours();
      
      const year = warsawDate.getFullYear();
      const month = String(warsawDate.getMonth() + 1).padStart(2, '0');
      const day = String(warsawDate.getDate()).padStart(2, '0');
      const todayStr = `${year}-${month}-${day}`;

      const state = this.planStore.getPlanState();

      // If it's at or after target hour (e.g. 21:00) and hasn't run yet today
      if (currentHour >= this.targetHour && state.last_digest_date !== todayStr) {
        logger.info({ today: todayStr, currentHour, targetHour: this.targetHour }, 'triggering_scheduled_daily_digest');
        await this.digestService.runDailyDigest({ forceDate: todayStr });
      }
    } catch (err) {
      logger.error({ err }, 'error_during_scheduled_check');
    }
  }
}
