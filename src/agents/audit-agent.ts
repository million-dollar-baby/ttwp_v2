// src/agents/audit-agent.ts
// Runs a full site audit and produces a structured health report.
// Combines WP-CLI, REST API, and browser tools.

import Anthropic from '@anthropic-ai/sdk';
import { BaseAgent } from './base';
import { AgentName, SiteConfig } from '../types';
import { WpCliTool, wpCliToolDefinitions, dispatchWpCliTool } from '../tools/wpcli';
import { WordPressApiTool, wpApiToolDefinitions, dispatchWpApiTool } from '../tools/wordpress-api';
import { BrowserTool, browserToolDefinitions, dispatchBrowserTool } from '../tools/browser';

export class AuditAgent extends BaseAgent {
  name: AgentName = 'tester'; // audit lives in the tester/verification domain
  private wpCli: WpCliTool;
  private wpApi: WordPressApiTool;
  private browser: BrowserTool;

  systemPrompt = `You are the Audit agent in a WordPress maintenance system.
Your job is to produce a comprehensive, structured health report for the WordPress site.

AUDIT CHECKLIST — work through ALL of these:

1. WORDPRESS CORE
   - Current version and update availability
   - PHP version
   - Active debug mode (should be OFF on production)

2. PLUGINS
   - Full list with versions and active status
   - Available updates
   - Any deactivated/broken plugins

3. THEMES
   - Active theme and version
   - Update availability
   - Child theme usage

4. CONTENT AUDIT
   - Total posts, pages (published, draft, trash)
   - Orphaned drafts older than 6 months
   - Posts with missing featured images
   - Pages with no content

5. MEDIA
   - Images missing alt text (accessibility and SEO issue)
   - Total media count

6. SECURITY
   - Default admin username still in use?
   - File editor enabled? (should be disabled on production)
   - Any plugins with known vulnerabilities (check version numbers)

7. PERFORMANCE (via browser)
   - Homepage load time
   - Admin dashboard load time

8. ERRORS
   - PHP error log tail (last 50 lines)
   - WordPress debug log tail
   - Admin notices

9. DATABASE
   - DB size
   - Post revisions count (if excessive, flag for cleanup)
   - Transients count

OUTPUT FORMAT:
After gathering all data, produce a structured report with:
- SUMMARY (overall health score: ✅ Good / ⚠️ Needs Attention / 🔴 Critical Issues)
- CRITICAL ISSUES (must fix now)
- WARNINGS (should fix soon)
- INFO (observations)
- RECOMMENDATIONS (prioritised action list)

Use wp_* tools for server data, api_* tools for content data, and browser_* tools for front-end data.`;

  toolDefinitions: Anthropic.Tool[] = [
    ...wpCliToolDefinitions,
    ...wpApiToolDefinitions,
    ...browserToolDefinitions,
  ];

  constructor(config: SiteConfig, environment: 'production' | 'staging' = 'production') {
    super();
    this.wpCli = new WpCliTool(config, environment);
    this.wpApi = new WordPressApiTool(config, environment);
    this.browser = new BrowserTool(config, environment);
  }

  protected async executeTool(toolName: string, input: Record<string, unknown>): Promise<string> {
    if (toolName.startsWith('api_'))     return dispatchWpApiTool(this.wpApi, toolName, input);
    if (toolName.startsWith('browser_')) return dispatchBrowserTool(this.browser, toolName, input);
    return dispatchWpCliTool(this.wpCli, toolName, input);
  }

  async cleanup(): Promise<void> {
    await this.wpCli.disconnect();
    await this.browser.close();
  }
}
