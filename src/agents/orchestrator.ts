// src/agents/orchestrator.ts
import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import {
  Task, TaskStatus, AgentName, SiteConfig,
} from '../types';
import {
  ANTHROPIC_API_KEY, MODEL, MAX_TOKENS, bus,
} from '../config';
import { saveTask, getRelevantMemory, getSiteMemory, saveSiteMemory } from '../memory/store';
import { createBackup, rollback } from '../safety/backup';
import { BuilderAgent, UpdaterAgent, DebuggerAgent, TesterAgent } from './agents';
import { ContentAgent } from './content-agent';
import { AuditAgent } from './audit-agent';
import { PerformanceAgent } from './performance-agent';
import { MonitorAgent } from './monitor-agent';
import { WpCliTool } from '../tools/wpcli';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

interface OrchestratorPlan {
  summary: string;
  steps: Array<{
    agent: AgentName;
    description: string;
    instruction: string;
    environment: 'staging' | 'production';
    requiresBackup: boolean;
  }>;
  useStaging: boolean;
  estimatedRisk: 'low' | 'medium' | 'high';
}

export class Orchestrator {
  private config: SiteConfig;

  constructor(config: SiteConfig) {
    this.config = config;
  }

  async run(taskDescription: string): Promise<Task> {
    const taskId = uuidv4();
    const now = new Date().toISOString();

    const task: Task = {
      id: taskId,
      description: taskDescription,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      steps: [],
    };

    saveTask(task);

    bus.emit_event({
      type: 'task:created',
      data: task,
      timestamp: now,
    });

    bus.log('info', `━━━ New Task: ${taskDescription}`, 'orchestrator');

    try {
      // 1. Plan the task
      const plan = await this.planTask(task);
      bus.log('info', `Plan: ${plan.summary} (${plan.steps.length} steps, risk: ${plan.estimatedRisk})`, 'orchestrator');

      // 2. Create backup if any step requires it
      if (plan.steps.some(s => s.requiresBackup)) {
        const wpcli = new WpCliTool(this.config, 'staging');
        task.backupId = (await createBackup(taskId, 'staging', { exec: cmd => wpcli.exec(cmd) }, this.config)).id;
        await wpcli.disconnect();
      }

      // 3. Execute each step
      for (const step of plan.steps) {
        bus.log('info', `Step: [${step.agent}] ${step.description}`, 'orchestrator');

        const result = await this.executeStep(task, step);

        if (!result.success && plan.estimatedRisk !== 'low') {
          bus.log('error', `Step failed. Considering rollback...`, 'orchestrator');

          // Ask for rollback if there's a backup
          if (task.backupId) {
            const wpcli = new WpCliTool(this.config, step.environment);
            const { getLatestBackup } = await import('../memory/store');
            const backup = getLatestBackup(taskId);
            if (backup) {
              await rollback(backup, { exec: cmd => wpcli.exec(cmd) }, this.config);
            }
            await wpcli.disconnect();
          }

          task.status = 'failed';
          task.error = result.error;
          task.updatedAt = new Date().toISOString();
          saveTask(task);
          return task;
        }
      }

      // 4. Final test pass (run tester after any non-trivial change)
      if (plan.steps.some(s => s.agent !== 'tester') && plan.estimatedRisk !== 'low') {
        bus.log('info', 'Running final verification test...', 'orchestrator');
        await this.runFinalTest(task, plan.useStaging ? 'staging' : 'production');
      }

      // 5. Update memory with what we learned
      await this.updateMemory(task);

      task.status = 'completed';
      task.updatedAt = new Date().toISOString();
      task.result = `Task completed successfully. ${task.steps.length} steps executed.`;
      saveTask(task);

      bus.emit_event({ type: 'task:updated', data: task, timestamp: task.updatedAt });
      bus.log('success', `━━━ Task complete: ${taskDescription}`, 'orchestrator');

      return task;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      task.status = 'failed';
      task.error = errorMsg;
      task.updatedAt = new Date().toISOString();
      saveTask(task);
      bus.log('error', `Task failed: ${errorMsg}`, 'orchestrator');
      return task;
    }
  }

  private async planTask(task: Task): Promise<OrchestratorPlan> {
    const memory = getRelevantMemory(task.description);
    const hasStagingEnv = !!(this.config.stagingUrl && this.config.stagingSshHost);

    const planPrompt = `You are the orchestrator of a WordPress maintenance AI system.

You have these specialist agents available:
- builder: Creates/edits pages, themes, CSS, PHP features, custom code
- content: Manages posts, pages, media, categories, tags, menus, widgets via REST API (no SSH needed)
- updater: Updates plugins, themes, WordPress core
- debugger: Reads error logs, diagnoses and fixes bugs in code
- tester: Tests the site in a real browser (navigation, forms, links, speed)
- audit: Comprehensive site health report (security, performance, content, versions)
- performance: Performance optimisation (Core Web Vitals, DB cleanup, caching, image audit)
- monitor: Health monitoring — uptime, SSL expiry, malware scan, cron health, error spikes, spam users, broken links

Your job is to create a step-by-step execution plan for the task below.

SITE CONTEXT:
${memory || 'No site context available yet.'}
${hasStagingEnv ? 'Staging environment is available.' : 'No staging environment configured — use production carefully.'}

TASK: ${task.description}

Respond in this EXACT JSON format (no other text):
{
  "summary": "One sentence describing the plan",
  "steps": [
    {
      "agent": "builder|updater|debugger|tester",
      "description": "Short step description",
      "instruction": "Detailed instruction for the agent",
      "environment": "staging|production",
      "requiresBackup": true|false
    }
  ],
  "useStaging": true|false,
  "estimatedRisk": "low|medium|high"
}

RULES:
- Always test on staging first when a staging env is available and changes are made
- Debugger should read logs BEFORE attempting any fix
- Tester should run AFTER any builder or updater changes
- requiresBackup: true for any step that modifies files or the database
- Split complex tasks into multiple focused steps`;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: planPrompt }],
    });

    const text = (response.content[0] as Anthropic.TextBlock).text.trim();

    try {
      // Strip markdown code fences if present
      const json = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
      return JSON.parse(json) as OrchestratorPlan;
    } catch {
      // Fallback plan
      bus.log('warn', 'Could not parse plan JSON, using fallback plan', 'orchestrator');
      return {
        summary: task.description,
        steps: [{
          agent: 'debugger',
          description: task.description,
          instruction: task.description,
          environment: hasStagingEnv ? 'staging' : 'production',
          requiresBackup: true,
        }],
        useStaging: hasStagingEnv,
        estimatedRisk: 'medium',
      };
    }
  }

  private async executeStep(
    task: Task,
    step: {
      agent: AgentName;
      description: string;
      instruction: string;
      environment: 'staging' | 'production';
    }
  ) {
    const env = step.environment as 'production' | 'staging';
    const memory = getRelevantMemory(step.description);
    const contextualInstruction = memory
      ? `${step.instruction}\n\nSite context:\n${memory}`
      : step.instruction;

    switch (step.agent) {
      case 'content': {
        const agent = new ContentAgent(this.config, env);
        const result = await agent.run(task, contextualInstruction, step.description);
        await agent.cleanup();
        return result;
      }
      case 'builder': {
        const agent = new BuilderAgent(this.config, env);
        const result = await agent.run(task, contextualInstruction, step.description);
        await agent.cleanup();
        return result;
      }
      case 'updater': {
        const agent = new UpdaterAgent(this.config, env);
        const result = await agent.run(task, contextualInstruction, step.description);
        await agent.cleanup();
        return result;
      }
      case 'debugger': {
        const agent = new DebuggerAgent(this.config, env);
        const result = await agent.run(task, contextualInstruction, step.description);
        await agent.cleanup();
        return result;
      }
      case 'tester': {
        const agent = new TesterAgent(this.config, env);
        const result = await agent.run(task, contextualInstruction, step.description);
        await agent.cleanup();
        return result;
      }
      case 'audit': {
        const agent = new AuditAgent(this.config, env);
        const result = await agent.run(task, contextualInstruction, step.description);
        await agent.cleanup();
        return result;
      }
      case 'performance': {
        const agent = new PerformanceAgent(this.config, env);
        const result = await agent.run(task, contextualInstruction, step.description);
        await agent.cleanup();
        return result;
      }
      case 'monitor': {
        const agent = new MonitorAgent(this.config, env);
        const result = await agent.run(task, contextualInstruction, step.description);
        await agent.cleanup();
        return result;
      }
      default:
        return { success: false, output: '', toolCalls: [], error: `Unknown agent: ${step.agent}` };
    }
  }

  private async runFinalTest(task: Task, environment: 'production' | 'staging'): Promise<void> {
    const tester = new TesterAgent(this.config, environment);
    await tester.run(
      task,
      `Run a comprehensive post-change verification test:
1. Check the homepage loads
2. Check the WordPress admin for errors
3. Test any pages or features that were modified in this task
4. Report any issues found

Task that was just completed: ${task.description}`,
      'Post-change verification'
    );
    await tester.cleanup();
  }

  private async updateMemory(task: Task): Promise<void> {
    // Extract learnings from the task and update site memory
    const toolCallSummary = task.steps
      .flatMap(s => s.toolCalls)
      .map(tc => `${tc.tool}: ${JSON.stringify(tc.input).slice(0, 100)}`)
      .join('\n');

    if (!toolCallSummary) return;

    const memory = getSiteMemory();

    // Update WordPress/plugin versions if wp_list_plugins or wp_core_version was called
    for (const step of task.steps) {
      for (const tc of step.toolCalls) {
        if (tc.tool === 'wp_core_version' && tc.output) {
          memory.wordpressVersion = tc.output.trim();
        }
        if (tc.tool === 'wp_list_plugins' && tc.output) {
          try {
            const plugins = JSON.parse(tc.output);
            if (Array.isArray(plugins)) {
              memory.plugins = plugins.map((p: Record<string, string>) => ({
                name: p.name,
                slug: p.name,
                version: p.version,
                active: p.status === 'active',
              }));
            }
          } catch {
            // couldn't parse plugin list
          }
        }
      }
    }

    memory.lastScanned = new Date().toISOString();
    saveSiteMemory(memory);
  }
}
