// src/agents/base.ts
import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentName, AgentResult, Task, TaskStep, ToolCall,
} from '../types';
import {
  ANTHROPIC_API_KEY, MODEL, MAX_TOKENS,
  MAX_AGENT_ITERATIONS, bus,
} from '../config';
import { saveTask } from '../memory/store';
import { classifyRisk, requestApproval } from '../safety/approval';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

export abstract class BaseAgent {
  abstract name: AgentName;
  abstract systemPrompt: string;
  abstract toolDefinitions: Anthropic.Tool[];

  protected abstract executeTool(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<string>;

  // Subclasses override this to release SSH connections, close browsers, etc.
  async cleanup(): Promise<void> {}

  async run(task: Task, userMessage: string, stepDescription: string): Promise<AgentResult> {
    bus.log('info', `Starting: ${stepDescription}`, this.name);

    const step: TaskStep = {
      id: uuidv4(),
      description: stepDescription,
      agent: this.name,
      status: 'running',
      toolCalls: [],
      startedAt: new Date().toISOString(),
    };

    task.steps.push(step);
    task.assignedAgent = this.name;
    saveTask(task);

    bus.emit_event({
      type: 'step:started',
      data: { taskId: task.id, step },
      timestamp: new Date().toISOString(),
    });

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userMessage },
    ];

    const toolCalls: ToolCall[] = [];
    let iterations = 0;
    let finalOutput = '';

    try {
      while (iterations < MAX_AGENT_ITERATIONS) {
        iterations++;

        const response = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: this.systemPrompt,
          tools: this.toolDefinitions,
          messages,
        });

        // Collect any text blocks as running output
        const textBlocks = response.content.filter(b => b.type === 'text');
        if (textBlocks.length) {
          finalOutput = (textBlocks as Anthropic.TextBlock[]).map(b => b.text).join('\n');
          bus.log('debug', finalOutput.slice(0, 200), this.name);
        }

        // If no tool calls, we're done
        if (response.stop_reason === 'end_turn') {
          break;
        }

        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
        if (toolUseBlocks.length === 0) break;

        // Add assistant message
        messages.push({ role: 'assistant', content: response.content });

        // Execute each tool
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
          const callId = toolUse.id;
          const toolName = toolUse.name;
          const toolInput = toolUse.input as Record<string, unknown>;

          bus.log('debug', `→ ${toolName}(${JSON.stringify(toolInput).slice(0, 150)})`, this.name);

          bus.emit_event({
            type: 'tool:called',
            data: { taskId: task.id, stepId: step.id, tool: toolName, input: toolInput },
            timestamp: new Date().toISOString(),
          });

          // Safety gate for risky operations
          const risk = classifyRisk(toolName, toolInput);
          if (risk === 'high' || risk === 'critical') {
            const approved = await requestApproval(
              task,
              `${this.name} wants to execute: ${toolName}`,
              { toolName, input: toolInput },
              risk,
              true
            );
            if (!approved) {
              const result = `Action blocked: user did not approve ${toolName}`;
              toolResults.push({ type: 'tool_result', tool_use_id: callId, content: result });
              toolCalls.push({
                id: uuidv4(), tool: toolName, input: toolInput,
                output: result, timestamp: new Date().toISOString(),
              });
              continue;
            }
          }

          const startTs = Date.now();
          let toolOutput: string;

          try {
            toolOutput = await this.executeTool(toolName, toolInput);
          } catch (err) {
            toolOutput = `Error: ${err instanceof Error ? err.message : String(err)}`;
            bus.log('error', `Tool ${toolName} failed: ${toolOutput}`, this.name);
          }

          const durationMs = Date.now() - startTs;
          bus.log('debug', `← ${toolName} (${durationMs}ms): ${toolOutput.slice(0, 200)}`, this.name);

          bus.emit_event({
            type: 'tool:result',
            data: { taskId: task.id, stepId: step.id, tool: toolName, output: toolOutput, durationMs },
            timestamp: new Date().toISOString(),
          });

          toolResults.push({ type: 'tool_result', tool_use_id: callId, content: toolOutput });

          toolCalls.push({
            id: uuidv4(),
            tool: toolName,
            input: toolInput,
            output: toolOutput,
            timestamp: new Date().toISOString(),
            durationMs,
          });
        }

        messages.push({ role: 'user', content: toolResults });
      }

      step.status = 'completed';
      step.toolCalls = toolCalls;
      step.output = finalOutput;
      step.completedAt = new Date().toISOString();
      saveTask(task);

      bus.emit_event({
        type: 'step:completed',
        data: { taskId: task.id, step },
        timestamp: new Date().toISOString(),
      });

      bus.log('success', `Completed: ${stepDescription}`, this.name);

      return { success: true, output: finalOutput, toolCalls };

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      step.status = 'failed';
      step.toolCalls = toolCalls;
      step.completedAt = new Date().toISOString();
      saveTask(task);
      bus.log('error', `Failed: ${errorMsg}`, this.name);
      return { success: false, output: finalOutput, toolCalls, error: errorMsg };
    }
  }
}
