// src/tools/wpcli.ts
import { NodeSSH } from 'node-ssh';
import { SiteConfig } from '../types';
import { bus } from '../config';

export class WpCliTool {
  private ssh: NodeSSH;
  private connected = false;

  constructor(private config: SiteConfig, private environment: 'production' | 'staging' = 'production') {
    this.ssh = new NodeSSH();
  }

  get wpPath(): string {
    return this.environment === 'staging' && this.config.stagingWpPath
      ? this.config.stagingWpPath
      : this.config.wpPath;
  }

  get sshHost(): string {
    return this.environment === 'staging' && this.config.stagingSshHost
      ? this.config.stagingSshHost
      : this.config.sshHost;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.ssh.connect({
      host: this.sshHost,
      port: this.config.sshPort,
      username: this.config.sshUser,
      privateKeyPath: this.config.sshKeyPath,
    });
    this.connected = true;
    bus.log('debug', `SSH connected to ${this.sshHost}`, 'orchestrator');
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      this.ssh.dispose();
      this.connected = false;
    }
  }

  async exec(command: string): Promise<string> {
    await this.connect();
    const result = await this.ssh.execCommand(command, { cwd: this.wpPath });
    if (result.stderr && !result.stdout) {
      throw new Error(result.stderr);
    }
    return result.stdout + (result.stderr ? '\n[stderr]: ' + result.stderr : '');
  }

  async wp(args: string): Promise<string> {
    return this.exec(`wp ${args} --path=${this.wpPath} --allow-root`);
  }

  // ─── Plugin management ───────────────────────────────────

  async listPlugins(): Promise<string> {
    return this.wp('plugin list --format=json');
  }

  async updatePlugin(slug: string): Promise<string> {
    return this.wp(`plugin update ${slug}`);
  }

  async updateAllPlugins(): Promise<string> {
    return this.wp('plugin update --all');
  }

  async installPlugin(slug: string): Promise<string> {
    return this.wp(`plugin install ${slug} --activate`);
  }

  async activatePlugin(slug: string): Promise<string> {
    return this.wp(`plugin activate ${slug}`);
  }

  async deactivatePlugin(slug: string): Promise<string> {
    return this.wp(`plugin deactivate ${slug}`);
  }

  async deletePlugin(slug: string): Promise<string> {
    return this.wp(`plugin delete ${slug}`);
  }

  // ─── Theme management ────────────────────────────────────

  async listThemes(): Promise<string> {
    return this.wp('theme list --format=json');
  }

  async updateTheme(slug: string): Promise<string> {
    return this.wp(`theme update ${slug}`);
  }

  async activateTheme(slug: string): Promise<string> {
    return this.wp(`theme activate ${slug}`);
  }

  // ─── Core ────────────────────────────────────────────────

  async coreVersion(): Promise<string> {
    return this.wp('core version');
  }

  async coreUpdateCheck(): Promise<string> {
    return this.wp('core check-update --format=json');
  }

  async coreUpdate(): Promise<string> {
    return this.wp('core update');
  }

  async coreUpdateDB(): Promise<string> {
    return this.wp('core update-db');
  }

  // ─── Content ─────────────────────────────────────────────

  async listPosts(type = 'post', status = 'publish', perPage = 20): Promise<string> {
    return this.wp(`post list --post_type=${type} --post_status=${status} --posts_per_page=${perPage} --format=json`);
  }

  async getPost(id: number): Promise<string> {
    return this.wp(`post get ${id} --format=json`);
  }

  async createPost(data: Record<string, string>): Promise<string> {
    const args = Object.entries(data).map(([k, v]) => `--${k}="${v}"`).join(' ');
    return this.wp(`post create ${args} --porcelain`);
  }

  async updatePost(id: number, data: Record<string, string>): Promise<string> {
    const args = Object.entries(data).map(([k, v]) => `--${k}="${v}"`).join(' ');
    return this.wp(`post update ${id} ${args}`);
  }

  async deletePost(id: number, force = false): Promise<string> {
    return this.wp(`post delete ${id}${force ? ' --force' : ''}`);
  }

  async listPages(): Promise<string> {
    return this.wp('post list --post_type=page --format=json');
  }

  // ─── Options / Config ────────────────────────────────────

  async getOption(key: string): Promise<string> {
    return this.wp(`option get ${key}`);
  }

  async updateOption(key: string, value: string): Promise<string> {
    return this.wp(`option update ${key} "${value}"`);
  }

  // ─── Maintenance ─────────────────────────────────────────

  async maintenanceEnable(): Promise<string> {
    return this.wp('maintenance-mode activate');
  }

  async maintenanceDisable(): Promise<string> {
    return this.wp('maintenance-mode deactivate');
  }

  async flushCache(): Promise<string> {
    return this.wp('cache flush');
  }

  async flushRewrite(): Promise<string> {
    return this.wp('rewrite flush');
  }

  async cronRun(): Promise<string> {
    return this.wp('cron event run --due-now');
  }

  // ─── Error logs ──────────────────────────────────────────

  async getErrorLog(lines = 100): Promise<string> {
    return this.exec(`tail -n ${lines} ${this.wpPath}/wp-content/debug.log 2>/dev/null || echo "No debug log found"`);
  }

  async getPhpErrorLog(lines = 100): Promise<string> {
    return this.exec(`tail -n ${lines} /var/log/php/error.log 2>/dev/null || tail -n ${lines} /var/log/apache2/error.log 2>/dev/null || echo "No PHP error log found"`);
  }

  async enableDebugLog(): Promise<string> {
    return this.wp('config set WP_DEBUG true --raw && wp config set WP_DEBUG_LOG true --raw');
  }

  // ─── Database ────────────────────────────────────────────

  async dbQuery(sql: string): Promise<string> {
    // Escape single quotes in SQL
    const escaped = sql.replace(/'/g, "'\\''");
    return this.wp(`db query '${escaped}'`);
  }

  async dbOptimize(): Promise<string> {
    return this.wp('db optimize');
  }

  async dbRepair(): Promise<string> {
    return this.wp('db repair');
  }

  // ─── Search-replace (for URL migration) ──────────────────

  async searchReplace(from: string, to: string, dryRun = true): Promise<string> {
    return this.wp(`search-replace '${from}' '${to}'${dryRun ? ' --dry-run' : ''}`);
  }

  // ─── Filesystem ──────────────────────────────────────────

  async readFile(filePath: string): Promise<string> {
    return this.exec(`cat "${filePath}"`);
  }

  async writeFile(filePath: string, content: string): Promise<string> {
    // Write content via heredoc to avoid shell escaping issues
    const escaped = content.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    return this.exec(`cat > "${filePath}" << 'WPAGENTEOF'\n${content}\nWPAGENTEOF`);
  }

  async listFiles(dirPath: string): Promise<string> {
    return this.exec(`ls -la "${dirPath}"`);
  }

  async gitCommit(message: string): Promise<string> {
    return this.exec(`cd ${this.wpPath} && git add -A && git commit -m "${message}" 2>&1 || echo "Nothing to commit"`);
  }

  async gitStatus(): Promise<string> {
    return this.exec(`cd ${this.wpPath} && git status 2>&1`);
  }
}

// ─── Anthropic tool definitions for WP-CLI ───────────────────

export const wpCliToolDefinitions = [
  {
    name: 'wp_list_plugins',
    description: 'List all installed WordPress plugins with their status and versions',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'wp_update_plugin',
    description: 'Update a specific WordPress plugin to its latest version',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Plugin slug (e.g. woocommerce)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'wp_update_all_plugins',
    description: 'Update all WordPress plugins to their latest versions',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wp_install_plugin',
    description: 'Install and activate a WordPress plugin from the official repository',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Plugin slug from wordpress.org' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'wp_activate_plugin',
    description: 'Activate an installed WordPress plugin',
    input_schema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'wp_deactivate_plugin',
    description: 'Deactivate an active WordPress plugin',
    input_schema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'wp_delete_plugin',
    description: 'Delete an installed WordPress plugin (deactivates first)',
    input_schema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'wp_list_themes',
    description: 'List all installed WordPress themes',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wp_update_theme',
    description: 'Update a WordPress theme',
    input_schema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'wp_activate_theme',
    description: 'Switch the active WordPress theme',
    input_schema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'wp_core_version',
    description: 'Get the current WordPress version',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wp_core_update_check',
    description: 'Check if a WordPress core update is available',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wp_core_update',
    description: 'Update WordPress core to the latest version',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wp_list_posts',
    description: 'List WordPress posts or pages',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'post type (post, page, etc)', default: 'post' },
        status: { type: 'string', description: 'post status', default: 'publish' },
        per_page: { type: 'number', default: 20 },
      },
      required: [],
    },
  },
  {
    name: 'wp_get_post',
    description: 'Get a specific WordPress post by ID',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'wp_create_post',
    description: 'Create a new WordPress post or page',
    input_schema: {
      type: 'object',
      properties: {
        post_title: { type: 'string' },
        post_content: { type: 'string' },
        post_status: { type: 'string', default: 'publish' },
        post_type: { type: 'string', default: 'post' },
        post_name: { type: 'string', description: 'URL slug' },
      },
      required: ['post_title'],
    },
  },
  {
    name: 'wp_update_post',
    description: 'Update an existing WordPress post or page',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        post_title: { type: 'string' },
        post_content: { type: 'string' },
        post_status: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'wp_delete_post',
    description: 'Delete a WordPress post or page',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        force: { type: 'boolean', description: 'Skip trash and permanently delete', default: false },
      },
      required: ['id'],
    },
  },
  {
    name: 'wp_get_option',
    description: 'Read a WordPress option value',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'wp_update_option',
    description: 'Update a WordPress option value',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'wp_flush_cache',
    description: 'Flush the WordPress object cache',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wp_flush_rewrite',
    description: 'Flush WordPress rewrite rules (fixes 404 errors on pages)',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wp_get_error_log',
    description: 'Read the WordPress debug.log file',
    input_schema: {
      type: 'object',
      properties: { lines: { type: 'number', default: 100 } },
      required: [],
    },
  },
  {
    name: 'wp_get_php_error_log',
    description: 'Read the PHP/Apache error log',
    input_schema: {
      type: 'object',
      properties: { lines: { type: 'number', default: 100 } },
      required: [],
    },
  },
  {
    name: 'wp_read_file',
    description: 'Read a file on the server (PHP, CSS, JS, config files)',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to file' } },
      required: ['path'],
    },
  },
  {
    name: 'wp_write_file',
    description: 'Write/overwrite a file on the server. Always commit with git after writing.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to file' },
        content: { type: 'string', description: 'Complete file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'wp_list_files',
    description: 'List files in a directory on the server',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'wp_run_sql',
    description: 'Run a raw SQL query against the WordPress database',
    input_schema: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
    },
  },
  {
    name: 'wp_git_commit',
    description: 'Commit all current file changes to git',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Commit message' } },
      required: ['message'],
    },
  },
  {
    name: 'wp_maintenance_enable',
    description: 'Enable WordPress maintenance mode (shows maintenance page to visitors)',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wp_maintenance_disable',
    description: 'Disable WordPress maintenance mode',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wp_ssh_exec',
    description: 'Run an arbitrary shell command on the server (use sparingly)',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
];

// ─── Tool dispatcher ─────────────────────────────────────────

export async function dispatchWpCliTool(
  tool: WpCliTool,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case 'wp_list_plugins':       return tool.listPlugins();
    case 'wp_update_plugin':      return tool.updatePlugin(input.slug as string);
    case 'wp_update_all_plugins': return tool.updateAllPlugins();
    case 'wp_install_plugin':     return tool.installPlugin(input.slug as string);
    case 'wp_activate_plugin':    return tool.activatePlugin(input.slug as string);
    case 'wp_deactivate_plugin':  return tool.deactivatePlugin(input.slug as string);
    case 'wp_delete_plugin':      return tool.deletePlugin(input.slug as string);
    case 'wp_list_themes':        return tool.listThemes();
    case 'wp_update_theme':       return tool.updateTheme(input.slug as string);
    case 'wp_activate_theme':     return tool.activateTheme(input.slug as string);
    case 'wp_core_version':       return tool.coreVersion();
    case 'wp_core_update_check':  return tool.coreUpdateCheck();
    case 'wp_core_update':        return tool.coreUpdate();
    case 'wp_list_posts':
      return tool.listPosts(
        input.type as string || 'post',
        input.status as string || 'publish',
        input.per_page as number || 20
      );
    case 'wp_get_post':           return tool.getPost(input.id as number);
    case 'wp_create_post':        return tool.createPost(input as Record<string, string>);
    case 'wp_update_post': {
      const { id, ...data } = input as { id: number } & Record<string, string>;
      return tool.updatePost(id, data);
    }
    case 'wp_delete_post':        return tool.deletePost(input.id as number, input.force as boolean);
    case 'wp_get_option':         return tool.getOption(input.key as string);
    case 'wp_update_option':      return tool.updateOption(input.key as string, input.value as string);
    case 'wp_flush_cache':        return tool.flushCache();
    case 'wp_flush_rewrite':      return tool.flushRewrite();
    case 'wp_get_error_log':      return tool.getErrorLog(input.lines as number || 100);
    case 'wp_get_php_error_log':  return tool.getPhpErrorLog(input.lines as number || 100);
    case 'wp_read_file':          return tool.readFile(input.path as string);
    case 'wp_write_file':         return tool.writeFile(input.path as string, input.content as string);
    case 'wp_list_files':         return tool.listFiles(input.path as string);
    case 'wp_run_sql':            return tool.dbQuery(input.sql as string);
    case 'wp_git_commit':         return tool.gitCommit(input.message as string);
    case 'wp_maintenance_enable': return tool.maintenanceEnable();
    case 'wp_maintenance_disable':return tool.maintenanceDisable();
    case 'wp_ssh_exec':           return tool.exec(input.command as string);
    default:
      throw new Error(`Unknown WP-CLI tool: ${name}`);
  }
}
