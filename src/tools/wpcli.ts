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

  // ─── Menu management ─────────────────────────────────────

  async listMenus(): Promise<string> {
    return this.wp('menu list --format=json');
  }

  async createMenu(menuName: string): Promise<string> {
    return this.wp(`menu create "${menuName}" --porcelain`);
  }

  async deleteMenu(menuNameOrId: string): Promise<string> {
    return this.wp(`menu delete "${menuNameOrId}"`);
  }

  async listMenuItems(menuNameOrId: string): Promise<string> {
    return this.wp(`menu item list "${menuNameOrId}" --format=json`);
  }

  async addMenuItemUrl(menuNameOrId: string, url: string, title: string, parent = 0): Promise<string> {
    return this.wp(`menu item add-custom "${menuNameOrId}" "${title}" "${url}"${parent ? ` --parent-id=${parent}` : ''} --porcelain`);
  }

  async addMenuItemPost(menuNameOrId: string, postId: number, parent = 0): Promise<string> {
    return this.wp(`menu item add-post "${menuNameOrId}" ${postId}${parent ? ` --parent-id=${parent}` : ''} --porcelain`);
  }

  async deleteMenuItem(menuItemId: number): Promise<string> {
    return this.wp(`menu item delete ${menuItemId}`);
  }

  async listMenuLocations(): Promise<string> {
    return this.wp('menu location list --format=json');
  }

  async assignMenuToLocation(menuName: string, location: string): Promise<string> {
    return this.wp(`menu location assign "${menuName}" "${location}"`);
  }

  // ─── Widget management ────────────────────────────────────

  async listWidgets(sidebar?: string): Promise<string> {
    const cmd = sidebar
      ? `widget list "${sidebar}" --format=json`
      : 'sidebar list --format=json';
    return this.wp(cmd);
  }

  async addWidget(sidebar: string, name: string, position = 1, optionsJson = '{}'): Promise<string> {
    return this.wp(`widget add "${name}" "${sidebar}" ${position} --data='${optionsJson}'`);
  }

  async removeWidget(widgetId: string): Promise<string> {
    return this.wp(`widget delete "${widgetId}"`);
  }

  // ─── User management ─────────────────────────────────────

  async listUsers(role?: string, perPage = 50): Promise<string> {
    const roleFlag = role ? ` --role=${role}` : '';
    return this.wp(`user list${roleFlag} --number=${perPage} --format=json --fields=ID,user_login,user_email,roles,user_registered`);
  }

  async deleteUser(userId: number, reassignTo?: number): Promise<string> {
    const reassignFlag = reassignTo ? ` --reassign=${reassignTo}` : '';
    return this.wp(`user delete ${userId}${reassignFlag} --yes`);
  }

  async deleteSpamUsers(userIds: number[]): Promise<string> {
    if (userIds.length === 0) return 'No users to delete.';
    return this.wp(`user delete ${userIds.join(' ')} --yes`);
  }

  async createUser(login: string, email: string, role = 'subscriber', password?: string): Promise<string> {
    const passFlag = password ? ` --user_pass="${password}"` : '';
    return this.wp(`user create "${login}" "${email}" --role=${role}${passFlag} --porcelain`);
  }

  async updateUserPassword(userId: number, newPassword: string): Promise<string> {
    return this.wp(`user update ${userId} --user_pass="${newPassword}"`);
  }

  // ─── Cron management ─────────────────────────────────────

  async listCronEvents(): Promise<string> {
    return this.wp('cron event list --format=json');
  }

  async runCronEvent(hook: string): Promise<string> {
    return this.wp(`cron event run "${hook}"`);
  }

  async scheduleCronEvent(hook: string, nextRunTimestamp: number, recurrence: string): Promise<string> {
    return this.wp(`cron event schedule "${hook}" ${nextRunTimestamp} ${recurrence}`);
  }

  async deleteCronEvent(hook: string): Promise<string> {
    return this.wp(`cron event delete "${hook}"`);
  }

  async runAllOverdueCron(): Promise<string> {
    return this.wp('cron event run --due-now');
  }

  // ─── Database backup / restore ────────────────────────────

  async dbExport(filePath?: string): Promise<string> {
    const defaultPath = `/tmp/wp-backup-${Date.now()}.sql`;
    const target = filePath || defaultPath;
    await this.wp(`db export "${target}" --quiet`);
    return `Database exported to: ${target}`;
  }

  async dbImport(filePath: string): Promise<string> {
    return this.wp(`db import "${filePath}"`);
  }

  async dbSize(): Promise<string> {
    return this.wp('db size --format=json');
  }

  async dbCleanup(): Promise<string> {
    // Remove spam, trash, auto-drafts, and expired transients
    const steps = [
      'post delete $(wp post list --post_status=trash --format=ids --allow-root) --force --allow-root 2>/dev/null || true',
      'post delete $(wp post list --post_status=spam --format=ids --allow-root) --force --allow-root 2>/dev/null || true',
      'transient delete --expired --allow-root 2>/dev/null || true',
    ];
    const results: string[] = [];
    for (const step of steps) {
      try {
        results.push(await this.exec(`wp ${step} --path=${this.wpPath}`));
      } catch {
        results.push(`[skipped] ${step}`);
      }
    }
    return results.join('\n');
  }

  // ─── Cache management ─────────────────────────────────────

  async flushAllCaches(): Promise<string> {
    const results: string[] = [];
    // Flush object cache
    try { results.push('Object cache: ' + await this.wp('cache flush')); } catch { results.push('Object cache: skipped'); }
    // Flush rewrite rules
    try { results.push('Rewrite rules: ' + await this.wp('rewrite flush')); } catch { results.push('Rewrite: skipped'); }
    // W3 Total Cache
    try { results.push('W3TC: ' + await this.wp('w3-total-cache flush all')); } catch { /* not installed */ }
    // WP Super Cache
    try { results.push('WPSC: ' + await this.exec(`wp --path=${this.wpPath} super-cache flush --allow-root 2>/dev/null || true`)); } catch { /* not installed */ }
    // WP Rocket
    try { results.push('WP Rocket: ' + await this.wp('rocket clean --confirm')); } catch { /* not installed */ }
    return results.filter(Boolean).join('\n');
  }

  // ─── SEO tools ────────────────────────────────────────────

  async getRobotsFile(): Promise<string> {
    return this.exec(`cat ${this.wpPath}/robots.txt 2>/dev/null || echo "No robots.txt found"`);
  }

  async writeRobotsFile(content: string): Promise<string> {
    const escaped = content.replace(/'/g, `'\\''`);
    await this.exec(`echo '${escaped}' > ${this.wpPath}/robots.txt`);
    return 'robots.txt updated successfully';
  }

  async listRedirects(): Promise<string> {
    // Works with Redirection plugin table
    return this.wp('db query "SELECT id,url,action_data,hits FROM wp_redirection_items WHERE status=\'enabled\' ORDER BY hits DESC LIMIT 50" --format=json 2>/dev/null || echo "No Redirection plugin found"');
  }

  async checkPhpSyntax(filePath: string): Promise<string> {
    return this.exec(`php -l "${filePath}" 2>&1`);
  }
}

// ─── Anthropic tool definitions for WP-CLI ───────────────────

export const wpCliToolDefinitions = [
  {
    name: 'wp_list_plugins',
    description: 'List all installed WordPress plugins with their status and versions',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'wp_update_plugin',
    description: 'Update a specific WordPress plugin to its latest version',
    input_schema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'Plugin slug (e.g. woocommerce)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'wp_update_all_plugins',
    description: 'Update all WordPress plugins to their latest versions',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_install_plugin',
    description: 'Install and activate a WordPress plugin from the official repository',
    input_schema: {
      type: 'object' as const,
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
      type: 'object' as const,
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'wp_deactivate_plugin',
    description: 'Deactivate an active WordPress plugin',
    input_schema: {
      type: 'object' as const,
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'wp_delete_plugin',
    description: 'Delete an installed WordPress plugin (deactivates first)',
    input_schema: {
      type: 'object' as const,
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'wp_list_themes',
    description: 'List all installed WordPress themes',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_update_theme',
    description: 'Update a WordPress theme',
    input_schema: {
      type: 'object' as const,
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'wp_activate_theme',
    description: 'Switch the active WordPress theme',
    input_schema: {
      type: 'object' as const,
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'wp_core_version',
    description: 'Get the current WordPress version',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_core_update_check',
    description: 'Check if a WordPress core update is available',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_core_update',
    description: 'Update WordPress core to the latest version',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_list_posts',
    description: 'List WordPress posts or pages',
    input_schema: {
      type: 'object' as const,
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
      type: 'object' as const,
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'wp_create_post',
    description: 'Create a new WordPress post or page',
    input_schema: {
      type: 'object' as const,
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
      type: 'object' as const,
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
      type: 'object' as const,
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
      type: 'object' as const,
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'wp_update_option',
    description: 'Update a WordPress option value',
    input_schema: {
      type: 'object' as const,
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
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_flush_rewrite',
    description: 'Flush WordPress rewrite rules (fixes 404 errors on pages)',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_get_error_log',
    description: 'Read the WordPress debug.log file',
    input_schema: {
      type: 'object' as const,
      properties: { lines: { type: 'number', default: 100 } },
      required: [],
    },
  },
  {
    name: 'wp_get_php_error_log',
    description: 'Read the PHP/Apache error log',
    input_schema: {
      type: 'object' as const,
      properties: { lines: { type: 'number', default: 100 } },
      required: [],
    },
  },
  {
    name: 'wp_read_file',
    description: 'Read a file on the server (PHP, CSS, JS, config files)',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'Absolute path to file' } },
      required: ['path'],
    },
  },
  {
    name: 'wp_write_file',
    description: 'Write/overwrite a file on the server. Always commit with git after writing.',
    input_schema: {
      type: 'object' as const,
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
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'wp_run_sql',
    description: 'Run a raw SQL query against the WordPress database',
    input_schema: {
      type: 'object' as const,
      properties: { sql: { type: 'string' } },
      required: ['sql'],
    },
  },
  {
    name: 'wp_git_commit',
    description: 'Commit all current file changes to git',
    input_schema: {
      type: 'object' as const,
      properties: { message: { type: 'string', description: 'Commit message' } },
      required: ['message'],
    },
  },
  {
    name: 'wp_maintenance_enable',
    description: 'Enable WordPress maintenance mode (shows maintenance page to visitors)',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_maintenance_disable',
    description: 'Disable WordPress maintenance mode',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_ssh_exec',
    description: 'Run an arbitrary shell command on the server (use sparingly)',
    input_schema: {
      type: 'object' as const,
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },

  // ─── Menu management ─────────────────────────────────────
  {
    name: 'wp_list_menus',
    description: 'List all WordPress navigation menus',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_create_menu',
    description: 'Create a new navigation menu',
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Menu name' } },
      required: ['name'],
    },
  },
  {
    name: 'wp_delete_menu',
    description: 'Delete a navigation menu by name or ID',
    input_schema: {
      type: 'object' as const,
      properties: { menu: { type: 'string', description: 'Menu name or ID' } },
      required: ['menu'],
    },
  },
  {
    name: 'wp_list_menu_items',
    description: 'List all items in a navigation menu',
    input_schema: {
      type: 'object' as const,
      properties: { menu: { type: 'string', description: 'Menu name or ID' } },
      required: ['menu'],
    },
  },
  {
    name: 'wp_add_menu_item_url',
    description: 'Add a custom URL link to a navigation menu',
    input_schema: {
      type: 'object' as const,
      properties: {
        menu: { type: 'string', description: 'Menu name or ID' },
        url: { type: 'string', description: 'URL to link to' },
        title: { type: 'string', description: 'Link label' },
        parent: { type: 'number', description: 'Parent menu item ID (for dropdown)', default: 0 },
      },
      required: ['menu', 'url', 'title'],
    },
  },
  {
    name: 'wp_add_menu_item_post',
    description: 'Add a post or page to a navigation menu',
    input_schema: {
      type: 'object' as const,
      properties: {
        menu: { type: 'string', description: 'Menu name or ID' },
        post_id: { type: 'number', description: 'Post or page ID to add' },
        parent: { type: 'number', description: 'Parent menu item ID (for dropdown)', default: 0 },
      },
      required: ['menu', 'post_id'],
    },
  },
  {
    name: 'wp_delete_menu_item',
    description: 'Delete a specific item from a navigation menu',
    input_schema: {
      type: 'object' as const,
      properties: { item_id: { type: 'number', description: 'Menu item ID to delete' } },
      required: ['item_id'],
    },
  },
  {
    name: 'wp_list_menu_locations',
    description: 'List all registered menu locations in the active theme',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_assign_menu',
    description: 'Assign a navigation menu to a theme location (e.g. primary, footer)',
    input_schema: {
      type: 'object' as const,
      properties: {
        menu: { type: 'string', description: 'Menu name' },
        location: { type: 'string', description: 'Theme location slug (e.g. primary, footer)' },
      },
      required: ['menu', 'location'],
    },
  },

  // ─── Widget management ────────────────────────────────────
  {
    name: 'wp_list_widgets',
    description: 'List all sidebars and their widgets, or widgets in a specific sidebar',
    input_schema: {
      type: 'object' as const,
      properties: { sidebar: { type: 'string', description: 'Sidebar ID (optional, lists all if omitted)' } },
      required: [],
    },
  },
  {
    name: 'wp_add_widget',
    description: 'Add a widget to a sidebar',
    input_schema: {
      type: 'object' as const,
      properties: {
        sidebar: { type: 'string', description: 'Sidebar ID (e.g. sidebar-1, footer-1)' },
        widget: { type: 'string', description: 'Widget name (e.g. text, recent-posts, search)' },
        position: { type: 'number', description: 'Position in sidebar (1 = top)', default: 1 },
        options: { type: 'string', description: 'JSON string of widget options e.g. {"title":"My Widget"}', default: '{}' },
      },
      required: ['sidebar', 'widget'],
    },
  },
  {
    name: 'wp_remove_widget',
    description: 'Remove a widget from a sidebar by widget instance ID',
    input_schema: {
      type: 'object' as const,
      properties: { widget_id: { type: 'string', description: 'Widget instance ID (from wp_list_widgets)' } },
      required: ['widget_id'],
    },
  },

  // ─── User management ─────────────────────────────────────
  {
    name: 'wp_list_users',
    description: 'List WordPress users. Filter by role. Returns ID, login, email, role, registration date.',
    input_schema: {
      type: 'object' as const,
      properties: {
        role: { type: 'string', description: 'Filter by role: administrator, editor, author, contributor, subscriber' },
        per_page: { type: 'number', default: 50 },
      },
      required: [],
    },
  },
  {
    name: 'wp_delete_user',
    description: 'Delete a WordPress user by ID. Optionally reassign their content to another user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        user_id: { type: 'number' },
        reassign_to: { type: 'number', description: 'User ID to reassign posts to (recommended)' },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'wp_delete_spam_users',
    description: 'Bulk delete multiple spam/bot user accounts by their IDs',
    input_schema: {
      type: 'object' as const,
      properties: {
        user_ids: { type: 'array', items: { type: 'number' }, description: 'Array of user IDs to delete' },
      },
      required: ['user_ids'],
    },
  },
  {
    name: 'wp_create_user',
    description: 'Create a new WordPress user account',
    input_schema: {
      type: 'object' as const,
      properties: {
        login: { type: 'string', description: 'Username' },
        email: { type: 'string', description: 'Email address' },
        role: { type: 'string', description: 'Role: administrator, editor, author, subscriber', default: 'subscriber' },
        password: { type: 'string', description: 'Password (auto-generated if omitted)' },
      },
      required: ['login', 'email'],
    },
  },
  {
    name: 'wp_update_user_password',
    description: 'Change a WordPress user\'s password',
    input_schema: {
      type: 'object' as const,
      properties: {
        user_id: { type: 'number' },
        new_password: { type: 'string', description: 'New password for the user' },
      },
      required: ['user_id', 'new_password'],
    },
  },

  // ─── Cron management ─────────────────────────────────────
  {
    name: 'wp_list_cron_events',
    description: 'List all scheduled WordPress cron events with their next run times',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_run_cron_event',
    description: 'Manually trigger a specific WordPress cron event by hook name',
    input_schema: {
      type: 'object' as const,
      properties: { hook: { type: 'string', description: 'Cron hook name to run' } },
      required: ['hook'],
    },
  },
  {
    name: 'wp_run_overdue_cron',
    description: 'Run all WordPress cron events that are currently overdue',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_delete_cron_event',
    description: 'Delete a scheduled cron event by hook name',
    input_schema: {
      type: 'object' as const,
      properties: { hook: { type: 'string', description: 'Cron hook name to delete' } },
      required: ['hook'],
    },
  },

  // ─── Database ─────────────────────────────────────────────
  {
    name: 'wp_db_export',
    description: 'Export the WordPress database to a SQL dump file on the server',
    input_schema: {
      type: 'object' as const,
      properties: { file_path: { type: 'string', description: 'Path to save SQL file (default: /tmp/wp-backup-TIMESTAMP.sql)' } },
      required: [],
    },
  },
  {
    name: 'wp_db_import',
    description: 'Import a SQL dump file into the WordPress database',
    input_schema: {
      type: 'object' as const,
      properties: { file_path: { type: 'string', description: 'Path to the SQL file to import' } },
      required: ['file_path'],
    },
  },
  {
    name: 'wp_db_size',
    description: 'Get the current size of the WordPress database',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_db_cleanup',
    description: 'Remove WordPress database bloat: trashed posts, spam comments, expired transients',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },

  // ─── Cache ────────────────────────────────────────────────
  {
    name: 'wp_flush_all_caches',
    description: 'Flush all caches: object cache, rewrite rules, W3 Total Cache, WP Super Cache, WP Rocket',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },

  // ─── SEO ──────────────────────────────────────────────────
  {
    name: 'wp_get_robots',
    description: 'Read the robots.txt file from the WordPress root',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_write_robots',
    description: 'Write/update the robots.txt file',
    input_schema: {
      type: 'object' as const,
      properties: { content: { type: 'string', description: 'Full robots.txt content' } },
      required: ['content'],
    },
  },
  {
    name: 'wp_list_redirects',
    description: 'List active 301 redirects from the Redirection plugin',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'wp_check_php_syntax',
    description: 'Validate PHP syntax of a file before editing (php -l). Always run before writing any PHP file.',
    input_schema: {
      type: 'object' as const,
      properties: { file_path: { type: 'string', description: 'Absolute path to PHP file to validate' } },
      required: ['file_path'],
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

    // Menu management
    case 'wp_list_menus':         return tool.listMenus();
    case 'wp_create_menu':        return tool.createMenu(input.name as string);
    case 'wp_delete_menu':        return tool.deleteMenu(input.menu as string);
    case 'wp_list_menu_items':    return tool.listMenuItems(input.menu as string);
    case 'wp_add_menu_item_url':  return tool.addMenuItemUrl(input.menu as string, input.url as string, input.title as string, input.parent as number);
    case 'wp_add_menu_item_post': return tool.addMenuItemPost(input.menu as string, input.post_id as number, input.parent as number);
    case 'wp_delete_menu_item':   return tool.deleteMenuItem(input.item_id as number);
    case 'wp_list_menu_locations':return tool.listMenuLocations();
    case 'wp_assign_menu':        return tool.assignMenuToLocation(input.menu as string, input.location as string);

    // Widget management
    case 'wp_list_widgets':       return tool.listWidgets(input.sidebar as string | undefined);
    case 'wp_add_widget':         return tool.addWidget(input.sidebar as string, input.widget as string, input.position as number, input.options as string);
    case 'wp_remove_widget':      return tool.removeWidget(input.widget_id as string);

    // User management
    case 'wp_list_users':         return tool.listUsers(input.role as string | undefined, input.per_page as number);
    case 'wp_delete_user':        return tool.deleteUser(input.user_id as number, input.reassign_to as number | undefined);
    case 'wp_delete_spam_users':  return tool.deleteSpamUsers(input.user_ids as number[]);
    case 'wp_create_user':        return tool.createUser(input.login as string, input.email as string, input.role as string, input.password as string | undefined);
    case 'wp_update_user_password': return tool.updateUserPassword(input.user_id as number, input.new_password as string);

    // Cron management
    case 'wp_list_cron_events':   return tool.listCronEvents();
    case 'wp_run_cron_event':     return tool.runCronEvent(input.hook as string);
    case 'wp_run_overdue_cron':   return tool.runAllOverdueCron();
    case 'wp_delete_cron_event':  return tool.deleteCronEvent(input.hook as string);

    // Database
    case 'wp_db_export':          return tool.dbExport(input.file_path as string | undefined);
    case 'wp_db_import':          return tool.dbImport(input.file_path as string);
    case 'wp_db_size':            return tool.dbSize();
    case 'wp_db_cleanup':         return tool.dbCleanup();

    // Cache
    case 'wp_flush_all_caches':   return tool.flushAllCaches();

    // SEO
    case 'wp_get_robots':         return tool.getRobotsFile();
    case 'wp_write_robots':       return tool.writeRobotsFile(input.content as string);
    case 'wp_list_redirects':     return tool.listRedirects();
    case 'wp_check_php_syntax':   return tool.checkPhpSyntax(input.file_path as string);

    default:
      throw new Error(`Unknown WP-CLI tool: ${name}`);
  }
}
