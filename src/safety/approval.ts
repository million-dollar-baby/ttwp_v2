// src/safety/approval.ts
import { v4 as uuidv4 } from 'uuid';
import inquirer from 'inquirer';
import {
  ApprovalRequest, RiskLevel, Task,
} from '../types';
import { saveApproval, resolveApproval, listPendingApprovals } from '../memory/store';
import { bus, REQUIRE_APPROVAL } from '../config';

// Risk thresholds — only HIGH/CRITICAL require human approval
const APPROVAL_THRESHOLD: RiskLevel[] = ['high', 'critical'];

// Operations that are always considered high risk
export const HIGH_RISK_OPERATIONS = [
  'wp_core_update',
  'delete_plugin',
  'delete_theme',
  'drop_table',
  'delete_posts_bulk',
  'modify_wp_config',
  'modify_functions_php',
  'overwrite_theme_file',
  'run_raw_sql',
];

export function classifyRisk(toolName: string, input: Record<string, unknown>): RiskLevel {
  if (HIGH_RISK_OPERATIONS.includes(toolName)) return 'high';

  // Heuristic: deletes are high, updates medium, reads low
  if (toolName.startsWith('delete_') || toolName.includes('drop_')) return 'high';
  if (toolName.includes('update_') || toolName.includes('install_')) return 'medium';
  if (toolName.includes('write_') || toolName.includes('create_')) return 'medium';
  if (toolName.includes('activate_') || toolName.includes('deactivate_')) return 'medium';
  return 'low';
}

export async function requestApproval(
  task: Task,
  action: string,
  details: Record<string, unknown>,
  risk: RiskLevel,
  interactive: boolean = true
): Promise<boolean> {
  // Low/medium risk or approvals disabled → auto-approve
  if (!REQUIRE_APPROVAL || !APPROVAL_THRESHOLD.includes(risk)) {
    return true;
  }

  const req: ApprovalRequest = {
    id: uuidv4(),
    taskId: task.id,
    stepDescription: action,
    risk,
    action,
    details,
    createdAt: new Date().toISOString(),
    resolved: false,
  };

  saveApproval(req);

  bus.emit_event({
    type: 'approval:requested',
    data: req,
    timestamp: req.createdAt,
  });

  bus.log('warn',
    `⚠️  Approval required [${risk.toUpperCase()}]: ${action}`,
    'orchestrator'
  );

  if (interactive) {
    // CLI interactive mode: prompt the user inline
    const { approved } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'approved',
        message: `\n  Action : ${action}\n  Risk   : ${risk.toUpperCase()}\n  Details: ${JSON.stringify(details, null, 2)}\n\nApprove this action?`,
        default: false,
      },
    ]);

    resolveApproval(req.id, approved);

    bus.emit_event({
      type: 'approval:resolved',
      data: { ...req, approved, resolvedAt: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });

    return approved;
  } else {
    // Dashboard/API mode: wait for approval via the REST endpoint (polling)
    bus.log('info', `Waiting for dashboard approval (id: ${req.id})...`, 'orchestrator');
    return await waitForApproval(req.id, 300_000); // 5 min timeout
  }
}

async function waitForApproval(id: string, timeoutMs: number): Promise<boolean> {
  const { getApproval } = await import('../memory/store');
  const start = Date.now();

  return new Promise((resolve) => {
    const check = setInterval(() => {
      const req = getApproval(id);
      if (req?.resolved) {
        clearInterval(check);
        resolve(req.approved ?? false);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        bus.log('error', `Approval timed out for ${id}`, 'orchestrator');
        resolve(false);
      }
    }, 2000);
  });
}
