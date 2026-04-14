// src/tools/sftp.ts
// Handles reliable file uploads/downloads over SFTP using node-ssh.
// Replaces the heredoc approach in wpcli.ts for large or binary files.

import { NodeSSH } from 'node-ssh';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SiteConfig } from '../types';
import { bus } from '../config';
import Anthropic from '@anthropic-ai/sdk';

export class SftpTool {
  private ssh: NodeSSH;
  private connected = false;

  constructor(
    private config: SiteConfig,
    private environment: 'production' | 'staging' = 'production'
  ) {
    this.ssh = new NodeSSH();
  }

  get sshHost(): string {
    return this.environment === 'staging' && this.config.stagingSshHost
      ? this.config.stagingSshHost
      : this.config.sshHost;
  }

  get wpPath(): string {
    return this.environment === 'staging' && this.config.stagingWpPath
      ? this.config.stagingWpPath
      : this.config.wpPath;
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    await this.ssh.connect({
      host: this.sshHost,
      port: this.config.sshPort,
      username: this.config.sshUser,
      privateKeyPath: this.config.sshKeyPath,
    });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      this.ssh.dispose();
      this.connected = false;
    }
  }

  // ─── Download a remote file to a local temp path ──────────

  async downloadFile(remotePath: string): Promise<string> {
    await this.connect();
    const tmpPath = path.join(os.tmpdir(), `wpagent-${Date.now()}-${path.basename(remotePath)}`);
    await this.ssh.getFile(tmpPath, remotePath);
    bus.log('debug', `Downloaded ${remotePath} → ${tmpPath}`, 'builder');
    return tmpPath;
  }

  // ─── Read remote file content as string ──────────────────

  async readFile(remotePath: string): Promise<string> {
    const tmpPath = await this.downloadFile(remotePath);
    const content = fs.readFileSync(tmpPath, 'utf-8');
    fs.unlinkSync(tmpPath);
    return content;
  }

  // ─── Upload string content to a remote file ───────────────
  // This is the RELIABLE replacement for the heredoc approach.
  // We write to a local temp file first, then SFTP it up.

  async writeFile(remotePath: string, content: string): Promise<string> {
    await this.connect();

    // Write to local temp
    const tmpPath = path.join(os.tmpdir(), `wpagent-upload-${Date.now()}-${path.basename(remotePath)}`);
    fs.writeFileSync(tmpPath, content, 'utf-8');

    try {
      // Ensure remote directory exists
      const remoteDir = path.dirname(remotePath);
      await this.ssh.execCommand(`mkdir -p "${remoteDir}"`);

      // Upload
      await this.ssh.putFile(tmpPath, remotePath);
      bus.log('debug', `Uploaded ${tmpPath} → ${remotePath} (${content.length} chars)`, 'builder');
      return `File written: ${remotePath} (${content.length} bytes)`;
    } finally {
      fs.unlinkSync(tmpPath);
    }
  }

  // ─── Upload a local file to remote ───────────────────────

  async uploadFile(localPath: string, remotePath: string): Promise<string> {
    await this.connect();
    await this.ssh.putFile(localPath, remotePath);
    bus.log('debug', `Uploaded ${localPath} → ${remotePath}`, 'builder');
    return `Uploaded: ${remotePath}`;
  }

  // ─── Upload entire directory ──────────────────────────────

  async uploadDirectory(localDir: string, remoteDir: string): Promise<string> {
    await this.connect();
    await this.ssh.putDirectory(localDir, remoteDir, {
      recursive: true,
      concurrency: 5,
      validate: (itemPath: string) => {
        const base = path.basename(itemPath);
        return !base.startsWith('.') && base !== 'node_modules';
      },
    });
    return `Uploaded directory ${localDir} → ${remoteDir}`;
  }

  // ─── Patch: apply a targeted string replacement to a remote file ─

  async patchFile(
    remotePath: string,
    search: string,
    replace: string,
    occurrences: 'first' | 'all' = 'first'
  ): Promise<string> {
    const content = await this.readFile(remotePath);

    if (!content.includes(search)) {
      return `Patch not applied: search string not found in ${remotePath}`;
    }

    const patched = occurrences === 'all'
      ? content.split(search).join(replace)
      : content.replace(search, replace);

    await this.writeFile(remotePath, patched);

    const count = occurrences === 'all'
      ? (content.split(search).length - 1)
      : 1;

    return `Patched ${count} occurrence(s) in ${remotePath}`;
  }

  // ─── Create a backup copy of a file before editing ────────

  async backupFile(remotePath: string): Promise<string> {
    await this.connect();
    const backup = `${remotePath}.bak-${Date.now()}`;
    await this.ssh.execCommand(`cp "${remotePath}" "${backup}"`);
    return `Backup created: ${backup}`;
  }

  // ─── PHP syntax check ────────────────────────────────────

  async checkPhpSyntax(remotePath: string): Promise<string> {
    await this.connect();
    const result = await this.ssh.execCommand(`php -l "${remotePath}" 2>&1`);
    return result.stdout + result.stderr;
  }

  // ─── List directory ──────────────────────────────────────

  async listDirectory(remotePath: string, recursive = false): Promise<string> {
    await this.connect();
    const cmd = recursive
      ? `find "${remotePath}" -type f | head -100`
      : `ls -la "${remotePath}"`;
    const result = await this.ssh.execCommand(cmd);
    return result.stdout || result.stderr;
  }

  // ─── Find files by pattern ───────────────────────────────

  async findFiles(remotePath: string, pattern: string): Promise<string> {
    await this.connect();
    const result = await this.ssh.execCommand(
      `find "${remotePath}" -name "${pattern}" -type f 2>/dev/null | head -50`
    );
    return result.stdout || 'No files found';
  }

  // ─── Search file contents (grep) ─────────────────────────

  async grepFiles(remotePath: string, pattern: string, extensions = '*.php'): Promise<string> {
    await this.connect();
    const result = await this.ssh.execCommand(
      `grep -rn "${pattern}" "${remotePath}" --include="${extensions}" 2>/dev/null | head -30`
    );
    return result.stdout || 'No matches found';
  }
}

// ─── Tool definitions ─────────────────────────────────────────

export const sftpToolDefinitions: Anthropic.Tool[] = [
  {
    name: 'sftp_read_file',
    description: 'Read the full content of a file on the server via SFTP (more reliable than wp_read_file for large files)',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path on the server' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sftp_write_file',
    description: 'Write complete file content to the server via SFTP (reliable for large PHP/CSS/JS files). Always back up first for important files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path on the server' },
        content: { type: 'string', description: 'Complete file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'sftp_patch_file',
    description: 'Apply a targeted find-and-replace to a file on the server. Safer than rewriting the whole file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
        search: { type: 'string', description: 'Exact string to find (must be unique enough to be unambiguous)' },
        replace: { type: 'string', description: 'String to replace it with' },
        occurrences: { type: 'string', enum: ['first', 'all'], default: 'first' },
      },
      required: ['path', 'search', 'replace'],
    },
  },
  {
    name: 'sftp_backup_file',
    description: 'Create a timestamped backup copy of a file before editing it',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sftp_check_php_syntax',
    description: 'Run php -l to check a PHP file for syntax errors before deploying it',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sftp_list_directory',
    description: 'List files in a directory on the server',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean', default: false },
      },
      required: ['path'],
    },
  },
  {
    name: 'sftp_find_files',
    description: 'Find files matching a name pattern in a directory (e.g. "*.php", "functions.php")',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory to search in' },
        pattern: { type: 'string', description: 'Filename pattern e.g. "*.php"' },
      },
      required: ['path', 'pattern'],
    },
  },
  {
    name: 'sftp_grep',
    description: 'Search for a pattern inside files on the server (grep)',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory to search in' },
        pattern: { type: 'string', description: 'Text to search for' },
        extensions: { type: 'string', description: 'File extensions to include e.g. "*.php"', default: '*.php' },
      },
      required: ['path', 'pattern'],
    },
  },
];

export async function dispatchSftpTool(
  sftp: SftpTool,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case 'sftp_read_file':       return sftp.readFile(input.path as string);
    case 'sftp_write_file':      return sftp.writeFile(input.path as string, input.content as string);
    case 'sftp_patch_file':
      return sftp.patchFile(
        input.path as string,
        input.search as string,
        input.replace as string,
        (input.occurrences as 'first' | 'all') || 'first'
      );
    case 'sftp_backup_file':     return sftp.backupFile(input.path as string);
    case 'sftp_check_php_syntax': return sftp.checkPhpSyntax(input.path as string);
    case 'sftp_list_directory':  return sftp.listDirectory(input.path as string, input.recursive as boolean);
    case 'sftp_find_files':      return sftp.findFiles(input.path as string, input.pattern as string);
    case 'sftp_grep':            return sftp.grepFiles(input.path as string, input.pattern as string, input.extensions as string);
    default:
      throw new Error(`Unknown SFTP tool: ${name}`);
  }
}
