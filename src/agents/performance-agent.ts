// src/agents/performance-agent.ts
import Anthropic from '@anthropic-ai/sdk';
import { BaseAgent } from './base';
import { AgentName, SiteConfig } from '../types';
import { WpCliTool, wpCliToolDefinitions, dispatchWpCliTool } from '../tools/wpcli';
import { PerformanceTool, performanceToolDefinitions, dispatchPerformanceTool } from '../tools/performance';

export class PerformanceAgent extends BaseAgent {
  name: AgentName = 'builder'; // performance optimisation is a build-domain task
  private wpCli: WpCliTool;
  private perf: PerformanceTool;

  systemPrompt = `You are the Performance Optimisation agent in a WordPress maintenance system.
Your job is to make the WordPress site as fast as possible.

WHAT YOU CAN DO:
- Measure real Core Web Vitals (LCP, CLS, TTFB) with a real browser
- Clean the database (revisions, transients, spam, orphaned data)
- Audit and report image issues (missing alt text, no optimisation plugin)
- Check caching configuration (plugins, gzip, object cache)
- Enable/configure caching plugins via WP-CLI
- Flush all caches after changes
- Report actionable recommendations

PERFORMANCE WORKFLOW:
1. Run perf_full_report for a complete baseline picture
2. Prioritise issues by impact: Core Web Vitals > caching > images > database
3. For each issue, apply what you CAN fix automatically (DB cleanup, cache flush)
4. For issues requiring plugin installation or configuration, recommend and optionally install
5. Re-measure Core Web Vitals after fixes to show improvement
6. Produce a before/after comparison report

PERFORMANCE BENCHMARKS:
- LCP < 2.5s = Good, 2.5–4s = Needs work, >4s = Poor
- CLS < 0.1 = Good, 0.1–0.25 = Needs work, >0.25 = Poor
- TTFB < 800ms = Good, 800–1800ms = Needs work, >1800ms = Poor
- Page load < 3s = Good target for most WordPress sites`;

  toolDefinitions: Anthropic.Tool[] = [
    ...performanceToolDefinitions,
    ...wpCliToolDefinitions as Anthropic.Tool[],
  ];

  constructor(config: SiteConfig, environment: 'production' | 'staging' = 'production') {
    super();
    this.wpCli = new WpCliTool(config, environment);
    this.perf  = new PerformanceTool(config, environment);
  }

  protected async executeTool(toolName: string, input: Record<string, unknown>): Promise<string> {
    if (toolName.startsWith('perf_')) return dispatchPerformanceTool(this.perf, toolName, input);
    return dispatchWpCliTool(this.wpCli, toolName, input);
  }

  async cleanup(): Promise<void> {
    await this.wpCli.disconnect();
    await this.perf.disconnect();
  }
}
