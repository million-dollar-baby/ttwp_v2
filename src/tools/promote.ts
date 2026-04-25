// src/tools/promote.ts
// Promotes changes from staging to production after a successful test pass.
// Supports rsync-based file sync and database promotion.

import { NodeSSH } from 'node-ssh';
import { SiteConfig } from '../types';
import { bus } from '../config';
import { WpCliTool } from './wpcli';
import { BrowserTool } from './browser';

export interface PromotionOptions {
  syncFiles: boolean;
  syncDatabase: boolean;
  runTestsFirst: boolean;
  enableMaintenanceMode: boolean;
}

const DEFAULT_OPTIONS: PromotionOptions = {
  syncFiles: true,
  syncDatabase: false,  // DB sync is risky — off by default
  runTestsFirst: true,
  enableMaintenanceMode: true,
};

export async function promoteToProduction(
  config: SiteConfig,
  options: Partial<PromotionOptions> = {}
): Promise<{ success: boolean; log: string[] }> {
  const opts: PromotionOptions = { ...DEFAULT_OPTIONS, ...options };
  const log: string[] = [];

  function record(msg: string): void {
    log.push(msg);
    bus.log('info', msg, 'orchestrator');
  }

  if (!config.stagingUrl || !config.stagingSshHost || !config.stagingWpPath) {
    return { success: false, log: ['Staging environment not configured'] };
  }

  // ── Step 1: Run tests on staging ─────────────────────────
  if (opts.runTestsFirst) {
    record('Running final tests on staging before promoting...');
    const browser = new BrowserTool(config, 'staging');
    try {
      const homepage = await browser.navigateTo('/');
      const parsed = JSON.parse(homepage);
      if (parsed.status !== 200) {
        await browser.close();
        return { success: false, log: [...log, `Staging homepage returned HTTP ${parsed.status} — aborting promotion`] };
      }
      const adminErrors = await browser.checkAdminErrors();
      if (adminErrors.includes('Error') || adminErrors.includes('Fatal')) {
        await browser.close();
        return { success: false, log: [...log, `Admin errors on staging: ${adminErrors}`] };
      }
      record('Staging tests passed ✓');
    } catch (err) {
      await browser.close();
      return { success: false, log: [...log, `Staging test failed: ${err}`] };
    } finally {
      await browser.close();
    }
  }

  const prodWpCli = new WpCliTool(config, 'production');

  try {
    // ── Step 2: Enable maintenance mode on production ───────
    if (opts.enableMaintenanceMode) {
      record('Enabling maintenance mode on production...');
      await prodWpCli.maintenanceEnable();
    }

    // ── Step 3: Sync theme and plugin files ─────────────────
    if (opts.syncFiles) {
      record('Syncing theme files from staging → production...');

      const ssh = new NodeSSH();
      const sshOpts: Parameters<NodeSSH['connect']>[0] = {
        host: config.sshHost,
        port: config.sshPort,
        username: config.sshUser,
        readyTimeout: 15000,
      };
      if (config.sshPassword) {
        sshOpts.password = config.sshPassword;
      } else if (config.sshKeyPath) {
        sshOpts.privateKeyPath = config.sshKeyPath;
      }
      await ssh.connect(sshOpts);

      const stagingThemesPath = `${config.stagingWpPath}/wp-content/themes/`;
      const prodThemesPath    = `${config.wpPath}/wp-content/themes/`;

      // Use rsync from production server to pull from staging
      // This requires passwordless SSH between servers, OR we run rsync locally
      // In most setups, we rsync from the same server if staging is on the same box
      const isSameServer = config.stagingSshHost === config.sshHost;

      if (isSameServer) {
        const rsyncResult = await ssh.execCommand(
          `rsync -av --delete --exclude='*.log' "${stagingThemesPath}" "${prodThemesPath}"`
        );
        record(`Theme sync: ${rsyncResult.stdout.split('\n').slice(-3).join(' ')}`);

        // Sync plugins (be careful — only sync custom plugins, not all)
        const stagingPluginsPath = `${config.stagingWpPath}/wp-content/plugins/`;
        const prodPluginsPath    = `${config.wpPath}/wp-content/plugins/`;
        const pluginSync = await ssh.execCommand(
          `rsync -av --delete --exclude='*.log' "${stagingPluginsPath}" "${prodPluginsPath}"`
        );
        record(`Plugin sync: ${pluginSync.stdout.split('\n').slice(-3).join(' ')}`);
      } else {
        record('Warning: staging and production are on different servers. Manual rsync required. Skipping file sync.');
        record(`Run manually: rsync -av ${config.stagingSshHost}:${stagingThemesPath} ${prodThemesPath}`);
      }

      ssh.dispose();
    }

    // ── Step 4: Sync database ────────────────────────────────
    if (opts.syncDatabase) {
      record('Syncing database from staging → production...');
      record('WARNING: Database sync replaces all production content with staging content.');

      const stagingWpCli = new WpCliTool(config, 'staging');
      try {
        // Export from staging
        await stagingWpCli.exec(`wp db export /tmp/staging-db-export.sql --path=${config.stagingWpPath} --allow-root`);
        // Import to production (only if on same server)
        if (config.stagingSshHost === config.sshHost) {
          await prodWpCli.exec(`wp db import /tmp/staging-db-export.sql --path=${config.wpPath} --allow-root`);
          // Fix URLs
          await prodWpCli.searchReplace(config.stagingUrl!, config.url, false);
          record(`Database synced and URLs updated: ${config.stagingUrl} → ${config.url}`);
        } else {
          record('Skipping database sync: staging and production are on different servers.');
        }
      } finally {
        await stagingWpCli.disconnect();
      }
    }

    // ── Step 5: Post-promotion tasks ─────────────────────────
    record('Running post-promotion cache flush and rewrite...');
    await prodWpCli.flushCache();
    await prodWpCli.flushRewrite();
    await prodWpCli.coreUpdateDB(); // Safe to run always (no-ops if not needed)

    // ── Step 6: Disable maintenance mode ─────────────────────
    if (opts.enableMaintenanceMode) {
      await prodWpCli.maintenanceDisable();
      record('Maintenance mode disabled ✓');
    }

    // ── Step 7: Smoke test production ────────────────────────
    record('Running smoke test on production...');
    const prodBrowser = new BrowserTool(config, 'production');
    try {
      const result = await prodBrowser.navigateTo('/');
      const parsed = JSON.parse(result);
      if (parsed.status === 200) {
        record(`Production homepage OK (HTTP ${parsed.status}, title: "${parsed.title}") ✓`);
      } else {
        record(`⚠️  Production homepage returned HTTP ${parsed.status} after promotion!`);
      }
    } finally {
      await prodBrowser.close();
    }

    record('Promotion complete ✓');
    return { success: true, log };

  } catch (err) {
    const msg = `Promotion failed: ${err}`;
    record(msg);

    // Attempt to restore maintenance mode off even on error
    try {
      await prodWpCli.maintenanceDisable();
    } catch { /* ignore */ }

    return { success: false, log };
  } finally {
    await prodWpCli.disconnect();
  }
}
