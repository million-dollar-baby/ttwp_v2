// src/agents/monitor-agent.ts
// Monitor agent: runs health checks, uptime, SSL, malware, cron, and error spike detection.
// This agent is triggered by the scheduler for periodic checks or by user request.

import Anthropic from '@anthropic-ai/sdk';
import { BaseAgent } from './base';
import { AgentName, SiteConfig } from '../types';
import { monitorToolDefinitions, MonitorTool, dispatchMonitorTool } from '../tools/monitor';
import { wpCliToolDefinitions, WpCliTool, dispatchWpCliTool } from '../tools/wpcli';

export class MonitorAgent extends BaseAgent {
  name: AgentName = 'orchestrator'; // monitoring is orchestrator-level
  private monitor: MonitorTool;
  private wpCli: WpCliTool;

  systemPrompt = `You are the Monitor agent in a WordPress maintenance AI system.
Your job is to proactively check the health of the WordPress site and report issues clearly.

YOU CHECK FOR:
1. UPTIME — Is the site responding? What HTTP status code?
2. SSL CERTIFICATE — Is it valid? When does it expire? Alert if < 30 days.
3. PHP ERROR SPIKES — Are there unusually high error counts in logs?
4. WORDPRESS CRON — Are there overdue cron events?
5. MALWARE — Are there suspicious PHP files or eval/base64 patterns?
6. SPAM USERS — Are there newly registered bot/spam accounts?
7. BROKEN LINKS — Are there internal/external links returning 4xx/5xx?

SEVERITY RULES:
- 🔴 CRITICAL: Site down, malware detected, SSL expired
- 🟠 HIGH: SSL expiring < 7 days, cron failures, PHP fatal error spikes
- 🟡 MEDIUM: SSL expiring < 30 days, moderate error count, spam users found
- 🟢 LOW: Broken links, minor error counts

REPORTING FORMAT:
Always produce a structured health report. For each check:
- State what was checked
- State the result clearly (PASS / WARN / FAIL)
- For issues: state severity and recommended action

If a critical issue is found, recommend immediate action.
Never skip a check — always run all relevant checks for the task.`;

  toolDefinitions: Anthropic.Tool[] = [
    ...monitorToolDefinitions,
    ...wpCliToolDefinitions,
  ];

  constructor(config: SiteConfig, environment: 'production' | 'staging' = 'production') {
    super();
    this.monitor = new MonitorTool(config);
    this.wpCli = new WpCliTool(config, environment);
  }

  protected async executeTool(toolName: string, input: Record<string, unknown>): Promise<string> {
    if (toolName.startsWith('monitor_')) {
      return dispatchMonitorTool(this.monitor, toolName, input);
    }
    return dispatchWpCliTool(this.wpCli, toolName, input);
  }

  async cleanup(): Promise<void> {
    await this.monitor.disconnect();
    await this.wpCli.disconnect();
  }
}
