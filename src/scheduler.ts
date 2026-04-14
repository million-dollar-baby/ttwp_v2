// src/scheduler.ts
// Runs scheduled maintenance tasks automatically.
// Each schedule entry defines when to run and what task to give the orchestrator.

import { loadSiteConfig, bus } from './config';
import { Orchestrator } from './agents/orchestrator';
import { listTasks } from './memory/store';

interface ScheduleEntry {
  id: string;
  name: string;
  cronExpression: string; // simplified: 'daily' | 'weekly' | 'hourly' | 'monthly'
  task: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

// Default maintenance schedule
const DEFAULT_SCHEDULE: ScheduleEntry[] = [
  {
    id: 'daily-scan',
    name: 'Daily scan',
    cronExpression: 'daily',
    task: 'Scan the WordPress site: check for available plugin/theme/core updates, read error logs and report any new errors found since yesterday. Store findings in memory.',
    enabled: false,
  },
  {
    id: 'weekly-update',
    name: 'Weekly updates',
    cronExpression: 'weekly',
    task: 'Safely update all WordPress plugins and themes that have updates available. Enable maintenance mode first, update one by one, test after each update, disable maintenance mode when done.',
    enabled: false,
  },
  {
    id: 'weekly-test',
    name: 'Weekly site test',
    cronExpression: 'weekly',
    task: 'Run a comprehensive browser-based site test: check homepage, contact form, key pages, measure load times, check for broken links, check admin for notices. Report findings.',
    enabled: false,
  },
  {
    id: 'monthly-audit',
    name: 'Monthly audit',
    cronExpression: 'monthly',
    task: 'Run a full site audit: WordPress version, PHP version, all plugin versions, content audit (posts/pages/media), security checks, performance baseline, error log review. Produce a full health report.',
    enabled: false,
  },
  {
    id: 'daily-debug',
    name: 'Daily error check',
    cronExpression: 'daily',
    task: 'Read the WordPress debug log and PHP error log. If there are any new errors since yesterday, identify their source and apply fixes where safe to do so automatically.',
    enabled: false, // opt-in: auto-fixing errors can be risky without review
  },
];

function getIntervalMs(expression: string): number {
  const HOUR  = 60 * 60 * 1000;
  const DAY   = 24 * HOUR;
  const WEEK  = 7 * DAY;
  const MONTH = 30 * DAY;
  switch (expression) {
    case 'hourly':  return HOUR;
    case 'daily':   return DAY;
    case 'weekly':  return WEEK;
    case 'monthly': return MONTH;
    default: return DAY;
  }
}

function shouldRun(entry: ScheduleEntry): boolean {
  if (!entry.enabled) return false;
  if (!entry.lastRun)  return true;

  const lastRun = new Date(entry.lastRun).getTime();
  const interval = getIntervalMs(entry.cronExpression);
  return Date.now() - lastRun >= interval;
}

async function runScheduledTask(entry: ScheduleEntry): Promise<void> {
  bus.log('info', `Scheduler: running "${entry.name}"`, 'orchestrator');
  entry.lastRun = new Date().toISOString();

  try {
    const config = loadSiteConfig();
    const orchestrator = new Orchestrator(config);
    const task = await orchestrator.run(`[SCHEDULED: ${entry.name}] ${entry.task}`);
    bus.log(
      task.status === 'completed' ? 'success' : 'warn',
      `Scheduled task "${entry.name}" finished with status: ${task.status}`,
      'orchestrator'
    );
  } catch (err) {
    bus.log('error', `Scheduled task "${entry.name}" threw: ${err}`, 'orchestrator');
  }
}

export class Scheduler {
  private schedule: ScheduleEntry[];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(customSchedule?: ScheduleEntry[]) {
    this.schedule = customSchedule || DEFAULT_SCHEDULE;
  }

  start(checkIntervalMs = 60_000): void {
    bus.log('info', `Scheduler started. Checking every ${checkIntervalMs / 1000}s.`, 'orchestrator');

    this.timer = setInterval(async () => {
      for (const entry of this.schedule) {
        if (shouldRun(entry)) {
          await runScheduledTask(entry);
        }
      }
    }, checkIntervalMs);

    // Also run once at startup for any overdue tasks
    setTimeout(async () => {
      for (const entry of this.schedule) {
        if (shouldRun(entry)) {
          await runScheduledTask(entry);
        }
      }
    }, 5_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      bus.log('info', 'Scheduler stopped.', 'orchestrator');
    }
  }

  getStatus(): Array<ScheduleEntry & { isDue: boolean }> {
    return this.schedule.map(entry => ({
      ...entry,
      isDue: shouldRun(entry),
      nextRun: entry.lastRun
        ? new Date(new Date(entry.lastRun).getTime() + getIntervalMs(entry.cronExpression)).toISOString()
        : 'now',
    }));
  }

  enableTask(id: string): void {
    const entry = this.schedule.find(e => e.id === id);
    if (entry) entry.enabled = true;
  }

  disableTask(id: string): void {
    const entry = this.schedule.find(e => e.id === id);
    if (entry) entry.enabled = false;
  }

  async runNow(id: string): Promise<void> {
    const entry = this.schedule.find(e => e.id === id);
    if (!entry) throw new Error(`No schedule entry with id: ${id}`);
    await runScheduledTask(entry);
  }
}

export { DEFAULT_SCHEDULE };
export type { ScheduleEntry };
