// src/memory/store.ts
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {
  SiteMemory, Task, ApprovalRequest, BackupRecord,
  PluginInfo, PastFix, KnownIssue,
} from '../types';

const DB_PATH = path.join(process.cwd(), 'data', 'wp-agent.db');

function getDb(): Database.Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS past_fixes (
      id TEXT PRIMARY KEY,
      issue TEXT NOT NULL,
      solution TEXT NOT NULL,
      files_changed TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      successful INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS known_issues (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      resolved INTEGER DEFAULT 0
    );
  `);
}

// ─── Task CRUD ────────────────────────────────────────────────

export function saveTask(task: Task): void {
  const db = getDb();
  initSchema(db);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tasks (id, data, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(task.id, JSON.stringify(task), task.createdAt, task.updatedAt);
  db.close();
}

export function getTask(id: string): Task | undefined {
  const db = getDb();
  initSchema(db);
  const row = db.prepare('SELECT data FROM tasks WHERE id = ?').get(id) as { data: string } | undefined;
  db.close();
  return row ? JSON.parse(row.data) : undefined;
}

export function listTasks(limit = 50): Task[] {
  const db = getDb();
  initSchema(db);
  const rows = db.prepare('SELECT data FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as { data: string }[];
  db.close();
  return rows.map(r => JSON.parse(r.data));
}

// ─── Approval CRUD ────────────────────────────────────────────

export function saveApproval(req: ApprovalRequest): void {
  const db = getDb();
  initSchema(db);
  db.prepare(`
    INSERT OR REPLACE INTO approvals (id, task_id, data, created_at, resolved)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.id, req.taskId, JSON.stringify(req), req.createdAt, req.resolved ? 1 : 0);
  db.close();
}

export function getApproval(id: string): ApprovalRequest | undefined {
  const db = getDb();
  initSchema(db);
  const row = db.prepare('SELECT data FROM approvals WHERE id = ?').get(id) as { data: string } | undefined;
  db.close();
  return row ? JSON.parse(row.data) : undefined;
}

export function listPendingApprovals(): ApprovalRequest[] {
  const db = getDb();
  initSchema(db);
  const rows = db.prepare('SELECT data FROM approvals WHERE resolved = 0 ORDER BY created_at ASC').all() as { data: string }[];
  db.close();
  return rows.map(r => JSON.parse(r.data));
}

export function resolveApproval(id: string, approved: boolean): void {
  const db = getDb();
  initSchema(db);
  const row = db.prepare('SELECT data FROM approvals WHERE id = ?').get(id) as { data: string } | undefined;
  if (!row) { db.close(); return; }
  const req: ApprovalRequest = JSON.parse(row.data);
  req.resolved = true;
  req.approved = approved;
  req.resolvedAt = new Date().toISOString();
  db.prepare('UPDATE approvals SET data = ?, resolved = 1 WHERE id = ?').run(JSON.stringify(req), id);
  db.close();
}

// ─── Backup CRUD ──────────────────────────────────────────────

export function saveBackup(backup: BackupRecord): void {
  const db = getDb();
  initSchema(db);
  db.prepare(`
    INSERT INTO backups (id, task_id, data, created_at)
    VALUES (?, ?, ?, ?)
  `).run(backup.id, backup.taskId, JSON.stringify(backup), backup.createdAt);
  db.close();
}

export function getLatestBackup(taskId: string): BackupRecord | undefined {
  const db = getDb();
  initSchema(db);
  const row = db.prepare('SELECT data FROM backups WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId) as { data: string } | undefined;
  db.close();
  return row ? JSON.parse(row.data) : undefined;
}

// ─── Site Memory ──────────────────────────────────────────────

export function getSiteMemory(): SiteMemory {
  const db = getDb();
  initSchema(db);
  const row = db.prepare('SELECT value FROM site_memory WHERE key = ?').get('main') as { value: string } | undefined;
  db.close();
  if (!row) {
    return { plugins: [], themes: [], customizations: [], knownIssues: [], pastFixes: [] };
  }
  return JSON.parse(row.value);
}

export function saveSiteMemory(memory: SiteMemory): void {
  const db = getDb();
  initSchema(db);
  db.prepare(`
    INSERT OR REPLACE INTO site_memory (key, value, updated_at)
    VALUES ('main', ?, ?)
  `).run(JSON.stringify(memory), new Date().toISOString());
  db.close();
}

export function updatePluginInfo(plugin: PluginInfo): void {
  const memory = getSiteMemory();
  const idx = memory.plugins.findIndex(p => p.slug === plugin.slug);
  if (idx >= 0) memory.plugins[idx] = plugin;
  else memory.plugins.push(plugin);
  saveSiteMemory(memory);
}

export function recordFix(fix: PastFix): void {
  const memory = getSiteMemory();
  memory.pastFixes.unshift(fix);
  if (memory.pastFixes.length > 100) memory.pastFixes = memory.pastFixes.slice(0, 100);
  saveSiteMemory(memory);
}

export function recordIssue(issue: KnownIssue): void {
  const memory = getSiteMemory();
  memory.knownIssues.push(issue);
  saveSiteMemory(memory);
}

export function resolveIssue(issueId: string): void {
  const memory = getSiteMemory();
  const issue = memory.knownIssues.find(i => i.id === issueId);
  if (issue) {
    issue.resolved = true;
    saveSiteMemory(memory);
  }
}

export function getRelevantMemory(taskDescription: string): string {
  const memory = getSiteMemory();
  const lines: string[] = [];

  if (memory.wordpressVersion) {
    lines.push(`WordPress ${memory.wordpressVersion}, PHP ${memory.phpVersion || 'unknown'}`);
  }

  const activePlugins = memory.plugins.filter(p => p.active);
  if (activePlugins.length) {
    lines.push(`Active plugins (${activePlugins.length}): ${activePlugins.map(p => `${p.name} ${p.version}`).join(', ')}`);
  }

  if (memory.customizations.length) {
    lines.push(`Custom files: ${memory.customizations.map(c => c.file).join(', ')}`);
  }

  const openIssues = memory.knownIssues.filter(i => !i.resolved);
  if (openIssues.length) {
    lines.push(`Known open issues: ${openIssues.map(i => i.description).join('; ')}`);
  }

  const recentFixes = memory.pastFixes.slice(0, 5);
  if (recentFixes.length) {
    lines.push(`Recent fixes: ${recentFixes.map(f => f.issue + ' → ' + f.solution).join('; ')}`);
  }

  return lines.join('\n');
}
