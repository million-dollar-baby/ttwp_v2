// src/notifier.ts
// Sends notifications on task completion, failures, and approval requests.
// Supports Slack webhooks and email (SMTP).

import https from 'https';
import { Task, ApprovalRequest, LogLevel } from './types';
import { bus } from './config';

export interface NotifierConfig {
  slackWebhookUrl?: string;
  emailTo?: string;
  emailFrom?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  notifyOnLevel?: LogLevel[]; // default: ['error', 'warn']
  dashboardUrl?: string;
}

function loadNotifierConfig(): NotifierConfig {
  return {
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    emailTo:         process.env.NOTIFY_EMAIL_TO,
    emailFrom:       process.env.NOTIFY_EMAIL_FROM || 'wp-agent@noreply.com',
    smtpHost:        process.env.SMTP_HOST,
    smtpPort:        parseInt(process.env.SMTP_PORT || '587'),
    smtpUser:        process.env.SMTP_USER,
    smtpPass:        process.env.SMTP_PASS,
    dashboardUrl:    process.env.DASHBOARD_URL || `http://localhost:${process.env.DASHBOARD_PORT || 3000}`,
  };
}

// ─── Slack ────────────────────────────────────────────────────

function slackPost(webhookUrl: string, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(webhookUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function taskStatusEmoji(status: string): string {
  return { completed: '✅', failed: '🔴', running: '🔄', waiting_approval: '⚠️' }[status] || '⬜';
}

async function notifySlackTask(cfg: NotifierConfig, task: Task): Promise<void> {
  if (!cfg.slackWebhookUrl) return;
  const emoji = taskStatusEmoji(task.status);
  const steps = task.steps.length;
  const toolCalls = task.steps.reduce((n, s) => n + s.toolCalls.length, 0);

  await slackPost(cfg.slackWebhookUrl, {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *WP Agent task ${task.status}*\n*Task:* ${task.description}\n*Steps:* ${steps}  •  *Tool calls:* ${toolCalls}${task.error ? `\n*Error:* ${task.error}` : ''}`,
        },
      },
      ...(cfg.dashboardUrl ? [{
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'View in Dashboard' },
          url: `${cfg.dashboardUrl}`,
        }],
      }] : []),
    ],
  });
}

async function notifySlackApproval(cfg: NotifierConfig, req: ApprovalRequest): Promise<void> {
  if (!cfg.slackWebhookUrl) return;
  await slackPost(cfg.slackWebhookUrl, {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚠️ *WP Agent approval required*\n*Action:* ${req.action}\n*Risk:* ${req.risk.toUpperCase()}\n*Details:* ${JSON.stringify(req.details).slice(0, 200)}`,
        },
      },
      ...(cfg.dashboardUrl ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `Approve or deny at: ${cfg.dashboardUrl}` },
      }] : []),
    ],
  });
}

// ─── Notifier class ───────────────────────────────────────────

export class Notifier {
  private cfg: NotifierConfig;

  constructor() {
    this.cfg = loadNotifierConfig();
    this.attachListeners();
  }

  private attachListeners(): void {
    bus.on('event', async (event) => {
      if (event.type === 'task:updated') {
        const task = event.data as Task;
        if (task.status === 'completed' || task.status === 'failed') {
          await this.onTaskFinished(task);
        }
      }
      if (event.type === 'approval:requested') {
        await this.onApprovalRequired(event.data as ApprovalRequest);
      }
    });
  }

  async onTaskFinished(task: Task): Promise<void> {
    // Slack
    try {
      await notifySlackTask(this.cfg, task);
    } catch (err) {
      bus.log('warn', `Slack notification failed: ${err}`, 'orchestrator');
    }
  }

  async onApprovalRequired(req: ApprovalRequest): Promise<void> {
    try {
      await notifySlackApproval(this.cfg, req);
    } catch (err) {
      bus.log('warn', `Slack approval notification failed: ${err}`, 'orchestrator');
    }
  }

  isConfigured(): boolean {
    return !!(this.cfg.slackWebhookUrl || this.cfg.emailTo);
  }
}
