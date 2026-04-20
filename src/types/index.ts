// src/types/index.ts

export interface SiteConfig {
  url: string;
  wpUser: string;
  wpAppPassword: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshKeyPath: string;
  wpPath: string;
  stagingUrl?: string;
  stagingSshHost?: string;
  stagingWpPath?: string;
  dbHost: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  gitRepo?: string;
  gitBranch?: string;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'rolled_back';

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  assignedAgent?: AgentName;
  createdAt: string;
  updatedAt: string;
  steps: TaskStep[];
  result?: string;
  error?: string;
  backupId?: string;
}

export interface TaskStep {
  id: string;
  description: string;
  agent: AgentName;
  status: 'pending' | 'running' | 'completed' | 'failed';
  toolCalls: ToolCall[];
  output?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ToolCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  timestamp: string;
  durationMs?: number;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ApprovalRequest {
  id: string;
  taskId: string;
  stepDescription: string;
  risk: RiskLevel;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
  resolved: boolean;
  approved?: boolean;
  resolvedAt?: string;
}

export interface BackupRecord {
  id: string;
  taskId: string;
  environment: 'production' | 'staging';
  filePath?: string;
  dbDump?: string;
  gitCommit?: string;
  createdAt: string;
}

// ─── Memory / Knowledge ───────────────────────────────────────

export interface SiteMemory {
  lastScanned?: string;
  wordpressVersion?: string;
  phpVersion?: string;
  plugins: PluginInfo[];
  themes: ThemeInfo[];
  customizations: Customization[];
  knownIssues: KnownIssue[];
  pastFixes: PastFix[];
  performanceBaseline?: PerformanceBaseline;
}

export interface PluginInfo {
  name: string;
  slug: string;
  version: string;
  active: boolean;
  updateAvailable?: boolean;
  notes?: string;
  knownConflicts?: string[];
}

export interface ThemeInfo {
  name: string;
  slug: string;
  version: string;
  active: boolean;
  customFiles?: string[];
}

export interface Customization {
  file: string;
  description: string;
  addedAt: string;
}

export interface KnownIssue {
  id: string;
  description: string;
  component: string;
  severity: 'low' | 'medium' | 'high';
  workaround?: string;
  discoveredAt: string;
  resolved: boolean;
}

export interface PastFix {
  id: string;
  issue: string;
  solution: string;
  filesChanged: string[];
  pluginsAffected: string[];
  appliedAt: string;
  successful: boolean;
}

export interface PerformanceBaseline {
  pages: Array<{
    url: string;
    loadTimeMs: number;
    lighthouseScore: number;
    measuredAt: string;
  }>;
}

// ─── Agent types ──────────────────────────────────────────────

export type AgentName = 'orchestrator' | 'builder' | 'content' | 'updater' | 'debugger' | 'tester' | 'audit' | 'performance' | 'monitor';

// ─── Monitoring ───────────────────────────────────────────────

export type MonitorSeverity = 'critical' | 'high' | 'medium' | 'low';
export type MonitorCheckType =
  | 'uptime'
  | 'ssl'
  | 'error_spike'
  | 'cron'
  | 'malware'
  | 'spam_users'
  | 'broken_links'
  | 'page_speed';

export interface MonitorAlert {
  id: string;
  checkType: MonitorCheckType;
  severity: MonitorSeverity;
  title: string;
  detail: string;
  autoResolved: boolean;
  triggeredAt: string;
  resolvedAt?: string;
  taskId?: string; // ID of remediation task if auto-fixed
}

export interface MonitorCheckResult {
  checkType: MonitorCheckType;
  passed: boolean;
  severity?: MonitorSeverity;
  summary: string;
  detail: Record<string, unknown>;
  checkedAt: string;
}

export interface SiteHealthSnapshot {
  siteId: string;
  checks: MonitorCheckResult[];
  alerts: MonitorAlert[];
  overallStatus: 'healthy' | 'degraded' | 'critical';
  snapshotAt: string;
}

export interface AgentResult {
  success: boolean;
  output: string;
  toolCalls: ToolCall[];
  error?: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

// ─── Dashboard event stream ───────────────────────────────────

export type EventType =
  | 'task:created'
  | 'task:updated'
  | 'step:started'
  | 'step:completed'
  | 'tool:called'
  | 'tool:result'
  | 'approval:requested'
  | 'approval:resolved'
  | 'log';

export interface DashboardEvent {
  type: EventType;
  data: unknown;
  timestamp: string;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'success';

export interface LogEntry {
  level: LogLevel;
  agent?: AgentName;
  message: string;
  timestamp: string;
}
