import schedule from 'node-schedule';
import { logger } from './logger';
import { config } from '../utils/config';
import { TIME_INTERVALS } from '../utils/constants';

/**
 * Scheduler for managing periodic trading tasks
 * Supports both minute-based (cron) and second-based (setInterval) scheduling
 */
class Scheduler {
  private jobs: Map<string, schedule.Job> = new Map();
  private intervals: Map<string, NodeJS.Timeout> = new Map(); // For sub-minute intervals
  private isRunning = false;

  /**
   * Schedules a task to run at specified intervals
   * Uses setInterval for sub-minute intervals, node-schedule for minute+
   */
  scheduleTask(
    name: string,
    interval: string,
    task: () => Promise<void>
  ): void {
    if (this.jobs.has(name) || this.intervals.has(name)) {
      logger.warn(`Task "${name}" is already scheduled. Cancelling previous job.`);
      this.cancelTask(name);
    }

    const intervalMs = TIME_INTERVALS[interval as keyof typeof TIME_INTERVALS];
    if (!intervalMs) {
      throw new Error(`Invalid interval: ${interval}`);
    }

    logger.info(`Scheduling task "${name}" to run every ${interval}`, {
      interval,
      intervalMs,
    });

    // Use setInterval for sub-minute intervals (ends with 's')
    if (interval.endsWith('s')) {
      const intervalId = setInterval(async () => {
        if (!this.isRunning) return;
        
        // Check if within trading hours
        if (!this.isWithinTradingHours()) {
          logger.debug(`Skipping task "${name}" - outside trading hours`);
          return;
        }

        try {
          logger.debug(`Executing scheduled task: ${name}`);
          await task();
        } catch (error) {
          logger.error(`Error executing scheduled task: ${name}`, error);
        }
      }, intervalMs);

      this.intervals.set(name, intervalId);
      logger.info(`Task "${name}" scheduled successfully (sub-minute interval)`);
      
      // Run immediately once
      if (this.isRunning) {
        task().catch(err => logger.error(`Initial task execution failed: ${name}`, err));
      }
      return;
    }

    // Use node-schedule for minute+ intervals
    const cronExpression = this.getCronExpression(interval);

    const job = schedule.scheduleJob(name, cronExpression, async () => {
      // Check if within trading hours
      if (!this.isWithinTradingHours()) {
        logger.debug(`Skipping task "${name}" - outside trading hours`);
        return;
      }

      try {
        logger.debug(`Executing scheduled task: ${name}`);
        await task();
      } catch (error) {
        logger.error(`Error executing scheduled task: ${name}`, error);
      }
    });

    if (job) {
      this.jobs.set(name, job);
      logger.info(`Task "${name}" scheduled successfully`);
    } else {
      logger.error(`Failed to schedule task: ${name}`);
    }
  }

  /**
   * Converts interval string to cron expression
   */
  private getCronExpression(interval: string): string {
    const cronExpressions: Record<string, string> = {
      '1m': '*/1 * * * *',    // Every 1 minute
      '5m': '*/5 * * * *',    // Every 5 minutes
      '15m': '*/15 * * * *',  // Every 15 minutes
      '30m': '*/30 * * * *',  // Every 30 minutes
      '1h': '0 * * * *',      // Every hour
      '4h': '0 */4 * * *',    // Every 4 hours
      '1d': '0 0 * * *',      // Every day at midnight
    };

    return cronExpressions[interval] || '*/1 * * * *';
  }

  /**
   * Checks if current time is within trading hours
   */
  private isWithinTradingHours(): boolean {
    const now = new Date();
    const currentHour = now.getUTCHours();

    const startHour = config.system.tradingStartHour;
    const endHour = config.system.tradingEndHour;

    // If start and end are the same, trade 24/7
    if (startHour === endHour && startHour === 0 && endHour === 23) {
      return true;
    }

    if (startHour <= endHour) {
      return currentHour >= startHour && currentHour <= endHour;
    } else {
      // Handle overnight trading (e.g., 22:00 to 06:00)
      return currentHour >= startHour || currentHour <= endHour;
    }
  }

  /**
   * Cancels a scheduled task
   */
  cancelTask(name: string): boolean {
    // Check node-schedule jobs
    const job = this.jobs.get(name);
    if (job) {
      job.cancel();
      this.jobs.delete(name);
      logger.info(`Task "${name}" cancelled (cron job)`);
      return true;
    }
    
    // Check setInterval intervals
    const intervalId = this.intervals.get(name);
    if (intervalId) {
      clearInterval(intervalId);
      this.intervals.delete(name);
      logger.info(`Task "${name}" cancelled (interval)`);
      return true;
    }
    
    logger.warn(`Task "${name}" not found`);
    return false;
  }

  /**
   * Cancels all scheduled tasks
   */
  cancelAllTasks(): void {
    logger.info('Cancelling all scheduled tasks');
    
    // Cancel cron jobs
    this.jobs.forEach((job, name) => {
      job.cancel();
      logger.debug(`Task "${name}" cancelled (cron job)`);
    });
    this.jobs.clear();
    
    // Cancel intervals
    this.intervals.forEach((intervalId, name) => {
      clearInterval(intervalId);
      logger.debug(`Task "${name}" cancelled (interval)`);
    });
    this.intervals.clear();
    
    this.isRunning = false;
  }

  /**
   * Gets list of active scheduled tasks
   */
  getActiveTasks(): string[] {
    return [...Array.from(this.jobs.keys()), ...Array.from(this.intervals.keys())];
  }

  /**
   * Checks if scheduler is running
   */
  isActive(): boolean {
    return this.isRunning && (this.jobs.size > 0 || this.intervals.size > 0);
  }

  /**
   * Starts the scheduler
   */
  start(): void {
    this.isRunning = true;
    logger.info('Scheduler started', {
      tradingHours: `${config.system.tradingStartHour}:00 - ${config.system.tradingEndHour}:00 UTC`,
      activeTasks: this.jobs.size + this.intervals.size,
    });
  }

  /**
   * Stops the scheduler
   */
  stop(): void {
    this.cancelAllTasks();
    logger.info('Scheduler stopped');
  }

  /**
   * Runs a task immediately (one-time execution)
   */
  async runTaskNow(task: () => Promise<void>): Promise<void> {
    logger.info('Running task immediately');
    try {
      await task();
      logger.info('Immediate task completed successfully');
    } catch (error) {
      logger.error('Immediate task failed', error);
      throw error;
    }
  }
}

// Export singleton instance
export const scheduler = new Scheduler();
export default scheduler;
