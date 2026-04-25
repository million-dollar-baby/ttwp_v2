// src/scheduler.ts
// Runs scheduled maintenance tasks automatically.
// Each schedule entry defines when to run and what task to give the orchestrator.

import { loadSiteConfig, bus } from "./config";
import { Orchestrator } from "./agents/orchestrator";
import { listTasks } from "./memory/store";
import { MonitorTool } from "./tools/monitor";

interface ScheduleEntry {
  id: string;
  name: string;
  cronExpression: string; // simplified: 'daily' | 'weekly' | 'hourly' | 'monthly'
  task: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  isMonitorCheck?: boolean; // true = run via MonitorTool directly, not Orchestrator
}

// Default maintenance schedule
const DEFAULT_SCHEDULE: ScheduleEntry[] = [
  // ─── Monitoring checks ────────────────────────────────────
  {
    id: "hourly-uptime",
    name: "Uptime check",
    cronExpression: "hourly",
    task: "Check if the site is up and responding. If the site is down or returning errors, immediately alert and attempt to diagnose the cause by checking error logs.",
    enabled: true,
  },
  {
    id: "daily-ssl",
    name: "SSL certificate check",
    cronExpression: "daily",
    task: "Check the SSL certificate for the site. Run monitor_check_ssl. If expiring within 30 days, alert with MEDIUM severity. If expiring within 7 days or already expired, alert CRITICAL.",
    enabled: true,
  },
  {
    id: "daily-malware",
    name: "Malware scan",
    cronExpression: "daily",
    task: "Run a malware scan using monitor_check_malware. Check for suspicious PHP files and eval/base64 injection patterns. If malware is detected, alert CRITICAL and report affected files.",
    enabled: true,
  },
  {
    id: "daily-cron-health",
    name: "WordPress cron health",
    cronExpression: "daily",
    task: "Check WordPress cron job health using monitor_check_cron. If there are overdue events, run wp_run_overdue_cron to process them and report results.",
    enabled: true,
  },
  {
    id: "daily-error-spike",
    name: "PHP error spike check",
    cronExpression: "daily",
    task: "Check PHP and WordPress error logs for error spikes using monitor_check_error_spike. If a spike is detected (10+ errors), read the top errors, identify the source plugin or theme, and report with recommendations.",
    enabled: true,
  },

  // ─── Maintenance tasks ────────────────────────────────────
  {
    id: "daily-scan",
    name: "Daily scan",
    cronExpression: "daily",
    task: "Scan the WordPress site: check for available plugin/theme/core updates, read error logs and report any new errors found since yesterday. Store findings in memory.",
    enabled: true,
  },
  {
    id: "daily-cache-flush",
    name: "Daily cache flush",
    cronExpression: "daily",
    task: "Flush all WordPress caches to ensure fresh content delivery. Use wp_flush_all_caches which covers object cache, rewrite rules, and popular cache plugins (W3TC, WP Super Cache, WP Rocket).",
    enabled: true,
  },
  {
    id: "weekly-update",
    name: "Weekly updates",
    cronExpression: "weekly",
    task: "Safely update all WordPress plugins and themes that have updates available. Enable maintenance mode first, update one by one, test after each update, disable maintenance mode when done.",
    enabled: true,
  },
  {
    id: "weekly-test",
    name: "Weekly site test",
    cronExpression: "weekly",
    task: "Run a comprehensive browser-based site test: check homepage, contact form, key pages, measure load times, check for broken links, check admin for notices. Report findings.",
    enabled: true,
  },
  {
    id: "weekly-spam-users",
    name: "Spam user cleanup",
    cronExpression: "weekly",
    task: "Detect and remove spam/bot user accounts. Run monitor_detect_spam_users to identify suspicious accounts registered in the last 7 days with no posts. Present the list for review. If auto-cleanup is approved, use wp_delete_spam_users to bulk remove them.",
    enabled: true,
  },
  {
    id: "weekly-broken-links",
    name: "Broken link scan",
    cronExpression: "weekly",
    task: "Scan all published posts and pages for broken external links (4xx/5xx responses) using monitor_scan_broken_links. Report any broken links found with their source page so they can be fixed.",
    enabled: true,
  },
  {
    id: "weekly-db-backup",
    name: "Weekly database backup",
    cronExpression: "weekly",
    task: "Export a full WordPress database backup using wp_db_export. Save to /tmp with a timestamped filename. Report the backup location and size. Log this as a successful backup event.",
    enabled: true,
  },
  {
    id: "weekly-db-optimize",
    name: "Weekly DB optimise",
    cronExpression: "weekly",
    task: "Optimise the WordPress database: run wp_db_cleanup to remove trash/spam/expired transients, then run wp_db_optimize to defragment tables. Report before and after DB size using wp_db_size.",
    enabled: true,
  },
  {
    id: "monthly-audit",
    name: "Monthly audit",
    cronExpression: "monthly",
    task: "Run a full site audit: WordPress version, PHP version, all plugin versions, content audit (posts/pages/media), security checks, performance baseline, error log review. Produce a full health report.",
    enabled: true,
  },
  {
    id: "daily-debug",
    name: "Daily error check",
    cronExpression: "daily",
    task: "Read the WordPress debug log and PHP error log. If there are any new errors since yesterday, identify their source and apply fixes where safe to do so automatically.",
    enabled: false, // opt-in: auto-fixing errors can be risky without review
  },
];

function getIntervalMs(expression: string): number {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  switch (expression) {
    case "hourly":
      return HOUR;
    case "daily":
      return DAY;
    case "weekly":
      return WEEK;
    case "monthly":
      return MONTH;
    default:
      return DAY;
  }
}

function shouldRun(entry: ScheduleEntry): boolean {
  if (!entry.enabled) return false;
  if (!entry.lastRun) return true;

  const lastRun = new Date(entry.lastRun).getTime();
  const interval = getIntervalMs(entry.cronExpression);
  return Date.now() - lastRun >= interval;
}

async function runScheduledTask(entry: ScheduleEntry): Promise<void> {
  const config = loadSiteConfig();
  if (!config.url) {
    bus.log(
      "debug",
      `Scheduler: skipping "${entry.name}" — no site configured yet`,
      "orchestrator",
    );
    return;
  }

  bus.log("info", `Scheduler: running "${entry.name}"`, "orchestrator");
  entry.lastRun = new Date().toISOString();

  try {
    const config = loadSiteConfig();
    const orchestrator = new Orchestrator(config);
    const task = await orchestrator.run(
      `[SCHEDULED: ${entry.name}] ${entry.task}`,
    );
    bus.log(
      task.status === "completed" ? "success" : "warn",
      `Scheduled task "${entry.name}" finished with status: ${task.status}`,
      "orchestrator",
    );
  } catch (err) {
    bus.log(
      "error",
      `Scheduled task "${entry.name}" threw: ${err}`,
      "orchestrator",
    );
  }
}

export class Scheduler {
  private schedule: ScheduleEntry[];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(customSchedule?: ScheduleEntry[]) {
    this.schedule = customSchedule || DEFAULT_SCHEDULE;
  }

  start(checkIntervalMs = 60_000): void {
    bus.log(
      "info",
      `Scheduler started. Checking every ${checkIntervalMs / 1000}s.`,
      "orchestrator",
    );

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
      bus.log("info", "Scheduler stopped.", "orchestrator");
    }
  }

  getStatus(): Array<ScheduleEntry & { isDue: boolean }> {
    return this.schedule.map((entry) => ({
      ...entry,
      isDue: shouldRun(entry),
      nextRun: entry.lastRun
        ? new Date(
            new Date(entry.lastRun).getTime() +
              getIntervalMs(entry.cronExpression),
          ).toISOString()
        : "now",
    }));
  }

  enableTask(id: string): void {
    const entry = this.schedule.find((e) => e.id === id);
    if (entry) entry.enabled = true;
  }

  disableTask(id: string): void {
    const entry = this.schedule.find((e) => e.id === id);
    if (entry) entry.enabled = false;
  }

  async runNow(id: string): Promise<void> {
    const entry = this.schedule.find((e) => e.id === id);
    if (!entry) throw new Error(`No schedule entry with id: ${id}`);
    await runScheduledTask(entry);
  }
}

export { DEFAULT_SCHEDULE };
export type { ScheduleEntry };
