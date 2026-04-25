// src/tools/monitor.ts
// Monitoring tools: uptime, SSL expiry, malware signatures, error spikes, cron status.
// These run without needing WordPress-specific credentials — plain HTTP or SSH.

import https from 'https';
import http from 'http';
import { NodeSSH } from 'node-ssh';
import { SiteConfig } from '../types';
import { bus } from '../config';
import Anthropic from '@anthropic-ai/sdk';

// ─── Types ───────────────────────────────────────────────────

export interface UptimeResult {
  up: boolean;
  statusCode?: number;
  responseTimeMs: number;
  error?: string;
  checkedAt: string;
}

export interface SslResult {
  valid: boolean;
  expiresAt?: string;
  daysRemaining?: number;
  issuer?: string;
  error?: string;
  checkedAt: string;
}

export interface ErrorSpikeResult {
  spikeDetected: boolean;
  recentErrors: number;
  previousErrors: number;
  topErrors: string[];
  checkedAt: string;
}

export interface CronStatusResult {
  healthy: boolean;
  overdueEvents: Array<{ hook: string; nextRun: string; interval: string }>;
  totalEvents: number;
  checkedAt: string;
}

export interface MalwareResult {
  suspicious: boolean;
  modifiedFiles: string[];
  suspiciousPatterns: string[];
  checkedAt: string;
}

export interface SpamUserResult {
  spamUsers: Array<{ id: number; login: string; email: string; registered: string }>;
  totalSpam: number;
  checkedAt: string;
}

export interface BrokenLinkResult {
  brokenLinks: Array<{ url: string; statusCode: number; foundOn: string }>;
  totalChecked: number;
  checkedAt: string;
}

// ─── MonitorTool class ────────────────────────────────────────

export class MonitorTool {
  private ssh: NodeSSH;
  private connected = false;

  constructor(private config: SiteConfig) {
    this.ssh = new NodeSSH();
  }

  private get wpPath(): string { return this.config.wpPath; }
  private get sshHost(): string { return this.config.sshHost; }

  async connect(): Promise<void> {
    if (this.connected) return;
    const opts: Parameters<NodeSSH['connect']>[0] = {
      host: this.sshHost,
      port: this.config.sshPort,
      username: this.config.sshUser,
      readyTimeout: 15000,
    };
    if (this.config.sshPassword) {
      opts.password = this.config.sshPassword;
    } else if (this.config.sshKeyPath) {
      opts.privateKeyPath = this.config.sshKeyPath;
    }
    await this.ssh.connect(opts);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      this.ssh.dispose();
      this.connected = false;
    }
  }

  private async exec(command: string): Promise<string> {
    await this.connect();
    const result = await this.ssh.execCommand(command, { cwd: this.wpPath });
    return result.stdout + (result.stderr ? '\n[stderr]: ' + result.stderr : '');
  }

  private async wp(args: string): Promise<string> {
    return this.exec(`wp ${args} --path=${this.wpPath} --allow-root`);
  }

  // ─── Uptime check ─────────────────────────────────────────

  async checkUptime(url?: string): Promise<UptimeResult> {
    const targetUrl = url || this.config.url;
    const start = Date.now();
    const checkedAt = new Date().toISOString();

    return new Promise((resolve) => {
      const parsed = new URL(targetUrl);
      const lib = parsed.protocol === 'https:' ? https : http;

      const req = lib.get(
        { host: parsed.hostname, path: parsed.pathname || '/', timeout: 15000 },
        (res: import('http').IncomingMessage) => {
          res.resume();
          res.on('end', () => {
            const responseTimeMs = Date.now() - start;
            const up = (res.statusCode ?? 0) < 500;
            bus.log(up ? 'success' : 'warn',
              `Uptime check: ${targetUrl} → ${res.statusCode} (${responseTimeMs}ms)`, 'orchestrator');
            resolve({ up, statusCode: res.statusCode, responseTimeMs, checkedAt });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve({ up: false, responseTimeMs: Date.now() - start, error: 'Request timed out after 15s', checkedAt });
      });

      req.on('error', (err: Error) => {
        resolve({ up: false, responseTimeMs: Date.now() - start, error: err.message, checkedAt });
      });
    });
  }

  // ─── SSL expiry check ─────────────────────────────────────

  async checkSsl(hostname?: string): Promise<SslResult> {
    const host = hostname || new URL(this.config.url).hostname;
    const checkedAt = new Date().toISOString();

    return new Promise((resolve) => {
      const req = https.request({ host, port: 443, method: 'HEAD', path: '/' }, (res: import('http').IncomingMessage) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cert = ((res.socket as any).getPeerCertificate?.()) as Record<string, any> | undefined;
        if (!cert || !cert['valid_to']) {
          resolve({ valid: false, error: 'Could not read certificate', checkedAt });
          return;
        }
        const expiresAt = new Date(cert['valid_to'] as string).toISOString();
        const daysRemaining = Math.floor((new Date(cert['valid_to'] as string).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        const valid = daysRemaining > 0;
        bus.log(daysRemaining < 30 ? 'warn' : 'success',
          `SSL: ${host} expires in ${daysRemaining} days`, 'orchestrator');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolve({ valid, expiresAt, daysRemaining, issuer: (cert['issuer'] as any)?.O, checkedAt });
      });

      req.on('error', (err: Error) => {
        resolve({ valid: false, error: err.message, checkedAt });
      });

      req.setTimeout(10000, () => {
        req.destroy();
        resolve({ valid: false, error: 'SSL check timed out', checkedAt });
      });

      req.end();
    });
  }

  // ─── PHP error spike detection ────────────────────────────

  async checkErrorSpike(windowMinutes = 60, spikeThreshold = 10): Promise<ErrorSpikeResult> {
    const checkedAt = new Date().toISOString();
    try {
      // Count errors in last N minutes vs previous N minutes
      const recentRaw = await this.exec(
        `find ${this.wpPath} -name "debug.log" 2>/dev/null | head -1 | xargs -I{} sh -c 'tail -2000 {} 2>/dev/null' | grep -c "PHP Fatal\\|PHP Warning\\|PHP Notice" || echo 0`
      );
      const recentErrors = parseInt(recentRaw.trim()) || 0;

      const topRaw = await this.exec(
        `find ${this.wpPath} -name "debug.log" 2>/dev/null | head -1 | xargs -I{} sh -c 'tail -500 {} 2>/dev/null' | grep "PHP Fatal\\|PHP Warning\\|PHP Notice" | sed 's/\\[.*\\]//' | sort | uniq -c | sort -rn | head -5 || echo "none"`
      );
      const topErrors = topRaw.split('\n').filter(Boolean).slice(0, 5);

      const spikeDetected = recentErrors >= spikeThreshold;
      if (spikeDetected) {
        bus.log('warn', `Error spike detected: ${recentErrors} PHP errors in log`, 'orchestrator');
      }

      return { spikeDetected, recentErrors, previousErrors: 0, topErrors, checkedAt };
    } catch (err) {
      return { spikeDetected: false, recentErrors: 0, previousErrors: 0, topErrors: [], checkedAt };
    }
  }

  // ─── WordPress cron status ────────────────────────────────

  async checkCronStatus(): Promise<CronStatusResult> {
    const checkedAt = new Date().toISOString();
    try {
      const raw = await this.wp('cron event list --format=json');
      const events: Array<Record<string, string>> = JSON.parse(raw);
      const now = Date.now();

      const overdueEvents = events
        .filter(e => {
          const nextRun = parseInt(e.next_run_gmt || '0') * 1000;
          return nextRun < now - 5 * 60 * 1000; // overdue by more than 5 min
        })
        .map(e => ({
          hook: e.hook,
          nextRun: new Date(parseInt(e.next_run_gmt) * 1000).toISOString(),
          interval: e.schedule || 'single',
        }));

      const healthy = overdueEvents.length === 0;
      if (!healthy) {
        bus.log('warn', `Cron: ${overdueEvents.length} overdue event(s) detected`, 'orchestrator');
      }

      return { healthy, overdueEvents, totalEvents: events.length, checkedAt };
    } catch (err) {
      return { healthy: false, overdueEvents: [], totalEvents: 0, checkedAt };
    }
  }

  // ─── Malware / suspicious file scan ──────────────────────

  async checkMalware(): Promise<MalwareResult> {
    const checkedAt = new Date().toISOString();
    try {
      // Files modified in last 24h outside uploads (common malware pattern)
      const modifiedRaw = await this.exec(
        `find ${this.wpPath} -name "*.php" -newer ${this.wpPath}/wp-login.php -not -path "*/uploads/*" -not -path "*/.git/*" 2>/dev/null | head -20`
      );
      const modifiedFiles = modifiedRaw.split('\n').filter(Boolean);

      // Scan for common malware patterns in recently modified PHP files
      const suspiciousPatterns: string[] = [];
      if (modifiedFiles.length > 0) {
        const scanRaw = await this.exec(
          `grep -rl "eval(base64_decode\\|exec(\\$_\\|system(\\$_\\|shell_exec(\\$_\\|preg_replace.*eval\\|str_rot13" ${this.wpPath} --include="*.php" -l 2>/dev/null | head -10 || echo ""`
        );
        if (scanRaw.trim()) {
          suspiciousPatterns.push(...scanRaw.split('\n').filter(Boolean));
        }
      }

      const suspicious = suspiciousPatterns.length > 0;
      if (suspicious) {
        bus.log('error', `Malware scan: ${suspiciousPatterns.length} suspicious file(s) found`, 'orchestrator');
      } else {
        bus.log('success', `Malware scan: No suspicious patterns detected`, 'orchestrator');
      }

      return { suspicious, modifiedFiles, suspiciousPatterns, checkedAt };
    } catch (err) {
      return { suspicious: false, modifiedFiles: [], suspiciousPatterns: [], checkedAt };
    }
  }

  // ─── Spam user detection ──────────────────────────────────

  async detectSpamUsers(): Promise<SpamUserResult> {
    const checkedAt = new Date().toISOString();
    try {
      // Users registered in last 7 days with spam email patterns or zero posts
      const raw = await this.wp(
        'user list --format=json --fields=ID,user_login,user_email,user_registered,post_count --number=200'
      );
      const users: Array<Record<string, string>> = JSON.parse(raw);
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

      const spamIndicators = /\.(ru|cn|xyz|top|icu|gq|cf|tk|ml)$|[0-9]{6,}@|noreply\+|disposable/i;

      const spamUsers = users
        .filter(u => {
          const isRecent = new Date(u.user_registered).getTime() > sevenDaysAgo;
          const hasNoPost = parseInt(u.post_count || '0') === 0;
          const emailLooksSuspicious = spamIndicators.test(u.user_email);
          return (isRecent && hasNoPost) || emailLooksSuspicious;
        })
        .map(u => ({
          id: parseInt(u.ID),
          login: u.user_login,
          email: u.user_email,
          registered: u.user_registered,
        }));

      bus.log(spamUsers.length > 0 ? 'warn' : 'success',
        `Spam users: ${spamUsers.length} potential spam account(s) found`, 'orchestrator');

      return { spamUsers, totalSpam: spamUsers.length, checkedAt };
    } catch (err) {
      return { spamUsers: [], totalSpam: 0, checkedAt };
    }
  }

  // ─── Broken link scan (lightweight, via WordPress posts) ──

  async scanBrokenLinks(maxLinks = 30): Promise<BrokenLinkResult> {
    const checkedAt = new Date().toISOString();
    const brokenLinks: BrokenLinkResult['brokenLinks'] = [];
    let totalChecked = 0;

    try {
      // Get all published post URLs
      const raw = await this.wp('post list --post_status=publish --format=json --fields=ID,post_title,guid --posts_per_page=50');
      const posts: Array<Record<string, string>> = JSON.parse(raw);

      for (const post of posts.slice(0, 10)) {
        // Extract href links from each post's content
        const contentRaw = await this.wp(`post get ${post.ID} --field=post_content`);
        const hrefs = [...contentRaw.matchAll(/href=["']([^"']+)["']/g)]
          .map(m => m[1])
          .filter(url => url.startsWith('http'))
          .slice(0, 5);

        for (const url of hrefs) {
          if (totalChecked >= maxLinks) break;
          totalChecked++;
          try {
            const result = await this.checkUrlStatus(url);
            if (result.statusCode && result.statusCode >= 400) {
              brokenLinks.push({ url, statusCode: result.statusCode, foundOn: post.guid });
            }
          } catch {
            brokenLinks.push({ url, statusCode: 0, foundOn: post.guid });
          }
        }

        if (totalChecked >= maxLinks) break;
      }

      bus.log(brokenLinks.length > 0 ? 'warn' : 'success',
        `Broken links: ${brokenLinks.length} broken out of ${totalChecked} checked`, 'orchestrator');

      return { brokenLinks, totalChecked, checkedAt };
    } catch (err) {
      return { brokenLinks: [], totalChecked, checkedAt };
    }
  }

  private checkUrlStatus(url: string): Promise<{ statusCode: number }> {
    return new Promise((resolve) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request({ host: parsed.hostname, path: parsed.pathname, method: 'HEAD', timeout: 8000 }, (res: import('http').IncomingMessage) => {
        req.destroy();
        resolve({ statusCode: res.statusCode ?? 0 });
      });
      req.on('error', () => resolve({ statusCode: 0 }));
      req.on('timeout', () => { req.destroy(); resolve({ statusCode: 0 }); });
      req.end();
    });
  }

  // ─── Page speed baseline comparison ──────────────────────

  async checkPageSpeedRegression(baseline: number, currentMs: number): Promise<{
    regression: boolean;
    baselineMs: number;
    currentMs: number;
    degradationPercent: number;
  }> {
    const degradationPercent = baseline > 0
      ? Math.round(((currentMs - baseline) / baseline) * 100)
      : 0;
    const regression = degradationPercent > 25; // >25% slower is a regression
    if (regression) {
      bus.log('warn', `Page speed regression: ${degradationPercent}% slower than baseline`, 'orchestrator');
    }
    return { regression, baselineMs: baseline, currentMs, degradationPercent };
  }
}

// ─── Anthropic tool definitions ───────────────────────────────

export const monitorToolDefinitions: Anthropic.Tool[] = [
  {
    name: 'monitor_check_uptime',
    description: 'Check if the WordPress site is up and responding. Returns status code and response time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Optional specific URL to check. Defaults to main site URL.' },
      },
      required: [],
    },
  },
  {
    name: 'monitor_check_ssl',
    description: 'Check SSL certificate validity and expiry date. Alerts if expiring within 30 days.',
    input_schema: {
      type: 'object' as const,
      properties: {
        hostname: { type: 'string', description: 'Optional hostname. Defaults to main site hostname.' },
      },
      required: [],
    },
  },
  {
    name: 'monitor_check_error_spike',
    description: 'Analyse PHP/WordPress error logs for unusual error spikes. Reads debug.log.',
    input_schema: {
      type: 'object' as const,
      properties: {
        spike_threshold: { type: 'number', description: 'Number of errors that triggers a spike alert', default: 10 },
      },
      required: [],
    },
  },
  {
    name: 'monitor_check_cron',
    description: 'Check WordPress cron jobs for overdue or failed events using WP-CLI.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'monitor_check_malware',
    description: 'Scan WordPress files for malware signatures and recently modified PHP files. Checks for eval/base64 patterns.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'monitor_detect_spam_users',
    description: 'Detect recently registered spam/bot user accounts based on email patterns and activity.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'monitor_scan_broken_links',
    description: 'Scan WordPress posts and pages for broken external links (HTTP 4xx/5xx responses).',
    input_schema: {
      type: 'object' as const,
      properties: {
        max_links: { type: 'number', description: 'Maximum number of links to check', default: 30 },
      },
      required: [],
    },
  },
];

// ─── Tool dispatcher ──────────────────────────────────────────

export async function dispatchMonitorTool(
  monitor: MonitorTool,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case 'monitor_check_uptime':
      return JSON.stringify(await monitor.checkUptime(input.url as string | undefined), null, 2);
    case 'monitor_check_ssl':
      return JSON.stringify(await monitor.checkSsl(input.hostname as string | undefined), null, 2);
    case 'monitor_check_error_spike':
      return JSON.stringify(await monitor.checkErrorSpike(60, input.spike_threshold as number | undefined), null, 2);
    case 'monitor_check_cron':
      return JSON.stringify(await monitor.checkCronStatus(), null, 2);
    case 'monitor_check_malware':
      return JSON.stringify(await monitor.checkMalware(), null, 2);
    case 'monitor_detect_spam_users':
      return JSON.stringify(await monitor.detectSpamUsers(), null, 2);
    case 'monitor_scan_broken_links':
      return JSON.stringify(await monitor.scanBrokenLinks(input.max_links as number | undefined), null, 2);
    default:
      throw new Error(`Unknown monitor tool: ${name}`);
  }
}
