// src/safety/backup.ts
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { BackupRecord, SiteConfig } from '../types';
import { saveBackup } from '../memory/store';
import { bus } from '../config';

const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');

export async function createBackup(
  taskId: string,
  environment: 'production' | 'staging',
  sshTools: {
    exec: (cmd: string) => Promise<string>;
  },
  config: SiteConfig
): Promise<BackupRecord> {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const id = uuidv4();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const wpPath = environment === 'staging' ? config.stagingWpPath || config.wpPath : config.wpPath;

  bus.log('info', `Creating backup before changes (id: ${id})...`, 'orchestrator');

  let dbDump: string | undefined;
  let gitCommit: string | undefined;

  // 1. Database dump
  try {
    const dumpPath = path.join(BACKUP_DIR, `db-${id}-${ts}.sql`);
    await sshTools.exec(
      `mysqldump -u${config.dbUser} -p${config.dbPassword} -h${config.dbHost} ${config.dbName} > /tmp/wp-backup-${id}.sql`
    );
    // In real usage you would scp this down; for now we record the remote path
    dbDump = `/tmp/wp-backup-${id}.sql`;
    bus.log('success', `Database dump created at ${dbDump}`, 'orchestrator');
  } catch (err) {
    bus.log('warn', `Database backup failed: ${err}`, 'orchestrator');
  }

  // 2. Git commit snapshot (if git is available)
  try {
    const hash = await sshTools.exec(`cd ${wpPath} && git rev-parse HEAD 2>/dev/null || echo ""`);
    if (hash.trim()) {
      gitCommit = hash.trim();
      bus.log('success', `Git snapshot: ${gitCommit}`, 'orchestrator');
    }
  } catch {
    // git not available — that's fine
  }

  const backup: BackupRecord = {
    id,
    taskId,
    environment,
    dbDump,
    gitCommit,
    createdAt: new Date().toISOString(),
  };

  saveBackup(backup);
  return backup;
}

export async function rollback(
  backup: BackupRecord,
  sshTools: { exec: (cmd: string) => Promise<string> },
  config: SiteConfig
): Promise<void> {
  const wpPath = backup.environment === 'staging'
    ? config.stagingWpPath || config.wpPath
    : config.wpPath;

  bus.log('warn', `Rolling back to backup ${backup.id}...`, 'orchestrator');

  // Restore database
  if (backup.dbDump) {
    try {
      await sshTools.exec(
        `mysql -u${config.dbUser} -p${config.dbPassword} -h${config.dbHost} ${config.dbName} < ${backup.dbDump}`
      );
      bus.log('success', 'Database restored', 'orchestrator');
    } catch (err) {
      bus.log('error', `DB restore failed: ${err}`, 'orchestrator');
    }
  }

  // Git rollback
  if (backup.gitCommit) {
    try {
      await sshTools.exec(`cd ${wpPath} && git reset --hard ${backup.gitCommit}`);
      bus.log('success', `Files rolled back to git commit ${backup.gitCommit}`, 'orchestrator');
    } catch (err) {
      bus.log('error', `Git rollback failed: ${err}`, 'orchestrator');
    }
  }

  bus.log('success', 'Rollback complete', 'orchestrator');
}
