// src/setup.ts
// Verifies all connections (SSH, WP-CLI, REST API, Playwright) before running tasks.
// Run this once after configuring .env to validate your setup.

import { loadSiteConfig, bus } from './config';
import { WpCliTool } from './tools/wpcli';
import { WordPressApiTool } from './tools/wordpress-api';
import { BrowserTool } from './tools/browser';
import { getSiteMemory, saveSiteMemory } from './memory/store';

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  detail?: string;
}

async function checkSsh(config: ReturnType<typeof loadSiteConfig>): Promise<CheckResult> {
  const wpCli = new WpCliTool(config, 'production');
  try {
    const result = await wpCli.exec('echo "ssh-ok"');
    await wpCli.disconnect();
    if (result.includes('ssh-ok')) {
      return { name: 'SSH connection', status: 'pass', message: `Connected to ${config.sshHost}` };
    }
    return { name: 'SSH connection', status: 'fail', message: 'Unexpected SSH response', detail: result };
  } catch (err) {
    await wpCli.disconnect();
    return { name: 'SSH connection', status: 'fail', message: `Cannot connect to ${config.sshHost}`, detail: String(err) };
  }
}

async function checkWpCli(config: ReturnType<typeof loadSiteConfig>): Promise<CheckResult> {
  const wpCli = new WpCliTool(config, 'production');
  try {
    const version = await wpCli.wp('--version');
    const wpVersion = await wpCli.coreVersion();
    await wpCli.disconnect();
    return {
      name: 'WP-CLI',
      status: 'pass',
      message: `${version.trim()} | WordPress ${wpVersion.trim()}`,
    };
  } catch (err) {
    await wpCli.disconnect();
    return {
      name: 'WP-CLI',
      status: 'fail',
      message: 'WP-CLI not found or not working',
      detail: `Install WP-CLI: https://wp-cli.org. Error: ${err}`,
    };
  }
}

async function checkPhp(config: ReturnType<typeof loadSiteConfig>): Promise<CheckResult> {
  const wpCli = new WpCliTool(config, 'production');
  try {
    const php = await wpCli.exec('php --version');
    await wpCli.disconnect();
    const match = php.match(/PHP (\d+\.\d+\.\d+)/);
    const version = match?.[1] || 'unknown';
    const major = parseInt(version.split('.')[0]);
    const minor = parseInt(version.split('.')[1]);
    const ok = major > 8 || (major === 8 && minor >= 1);
    return {
      name: 'PHP version',
      status: ok ? 'pass' : 'warn',
      message: `PHP ${version}`,
      detail: ok ? undefined : 'WordPress 6+ recommends PHP 8.1 or higher',
    };
  } catch (err) {
    return { name: 'PHP version', status: 'fail', message: String(err) };
  }
}

async function checkRestApi(config: ReturnType<typeof loadSiteConfig>): Promise<CheckResult> {
  const api = new WordPressApiTool(config, 'production');
  try {
    const info = await api.getSiteInfo();
    const parsed = JSON.parse(info);
    return {
      name: 'WordPress REST API',
      status: 'pass',
      message: `Site: "${parsed.name}" at ${parsed.url}`,
    };
  } catch (err) {
    return {
      name: 'WordPress REST API',
      status: 'fail',
      message: 'Cannot authenticate with REST API',
      detail: `Check WP_USER and WP_APP_PASSWORD. Create an Application Password at Users → Profile. Error: ${err}`,
    };
  }
}

async function checkStaging(config: ReturnType<typeof loadSiteConfig>): Promise<CheckResult> {
  if (!config.stagingUrl || !config.stagingSshHost) {
    return {
      name: 'Staging environment',
      status: 'warn',
      message: 'Not configured',
      detail: 'Set STAGING_URL and STAGING_SSH_HOST in .env to enable staging-first workflow',
    };
  }
  const wpCli = new WpCliTool(config, 'staging');
  try {
    const result = await wpCli.exec('echo "staging-ok"');
    await wpCli.disconnect();
    if (result.includes('staging-ok')) {
      return { name: 'Staging environment', status: 'pass', message: `Connected to ${config.stagingSshHost}` };
    }
    return { name: 'Staging environment', status: 'fail', message: 'Staging SSH connected but no response' };
  } catch (err) {
    await wpCli.disconnect();
    return { name: 'Staging environment', status: 'fail', message: `Cannot connect: ${err}` };
  }
}

async function checkGit(config: ReturnType<typeof loadSiteConfig>): Promise<CheckResult> {
  const wpCli = new WpCliTool(config, 'production');
  try {
    const result = await wpCli.exec(`cd ${config.wpPath} && git status 2>&1`);
    await wpCli.disconnect();
    if (result.includes('nothing to commit') || result.includes('On branch')) {
      return { name: 'Git repository', status: 'pass', message: 'Git repo found and clean' };
    }
    return {
      name: 'Git repository',
      status: 'warn',
      message: 'Git found but uncommitted changes exist',
      detail: result.slice(0, 200),
    };
  } catch {
    await wpCli.disconnect();
    return {
      name: 'Git repository',
      status: 'warn',
      message: 'Git not initialised in WP_PATH',
      detail: `Run: cd ${config.wpPath} && git init && git add -A && git commit -m "Initial snapshot"`,
    };
  }
}

async function checkPlaywright(): Promise<CheckResult> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('about:blank');
    await browser.close();
    return { name: 'Playwright (browser)', status: 'pass', message: 'Chromium launched successfully' };
  } catch (err) {
    return {
      name: 'Playwright (browser)',
      status: 'fail',
      message: 'Playwright not ready',
      detail: `Run: npx playwright install chromium. Error: ${err}`,
    };
  }
}

async function checkDebugMode(config: ReturnType<typeof loadSiteConfig>): Promise<CheckResult> {
  const wpCli = new WpCliTool(config, 'production');
  try {
    const debugVal = await wpCli.wp('config get WP_DEBUG --type=constant 2>/dev/null || echo "false"');
    await wpCli.disconnect();
    const isDebug = debugVal.trim() === '1' || debugVal.trim().toLowerCase() === 'true';
    return {
      name: 'WP_DEBUG mode',
      status: isDebug ? 'warn' : 'pass',
      message: isDebug ? 'WP_DEBUG is ON on production (not recommended)' : 'WP_DEBUG is OFF',
      detail: isDebug ? 'Set WP_DEBUG to false in wp-config.php for production' : undefined,
    };
  } catch {
    return { name: 'WP_DEBUG mode', status: 'warn', message: 'Could not check WP_DEBUG' };
  }
}

// ─── Run all checks and print report ─────────────────────────

export async function runSetupCheck(): Promise<boolean> {
  console.log('\n\x1b[1m━━━ WP Agent Setup Verification ━━━\x1b[0m\n');

  let config: ReturnType<typeof loadSiteConfig>;
  try {
    config = loadSiteConfig();
    console.log(`  Target: ${config.url}`);
    console.log(`  Server: ${config.sshUser}@${config.sshHost}:${config.wpPath}\n`);
  } catch (err) {
    console.error('\x1b[31m✗ Cannot load config. Is .env set up?\x1b[0m');
    console.error(String(err));
    return false;
  }

  const checks: CheckResult[] = [];

  const runCheck = async (fn: () => Promise<CheckResult>) => {
    const result = await fn();
    checks.push(result);
    const icon = result.status === 'pass' ? '\x1b[32m✓\x1b[0m'
      : result.status === 'warn' ? '\x1b[33m⚠\x1b[0m'
      : '\x1b[31m✗\x1b[0m';
    console.log(`  ${icon}  ${result.name.padEnd(28)} ${result.message}`);
    if (result.detail) console.log(`       \x1b[90m${result.detail}\x1b[0m`);
  };

  await runCheck(() => checkSsh(config));
  await runCheck(() => checkWpCli(config));
  await runCheck(() => checkPhp(config));
  await runCheck(() => checkRestApi(config));
  await runCheck(() => checkStaging(config));
  await runCheck(() => checkGit(config));
  await runCheck(() => checkPlaywright());
  await runCheck(() => checkDebugMode(config));

  const failures = checks.filter(c => c.status === 'fail');
  const warnings = checks.filter(c => c.status === 'warn');

  console.log('\n' + '─'.repeat(50));
  if (failures.length === 0) {
    console.log('\x1b[32m✓ All critical checks passed.\x1b[0m');
    if (warnings.length) {
      console.log(`\x1b[33m⚠  ${warnings.length} warning(s) — the system will work but review the items above.\x1b[0m`);
    }
    console.log('\nYou\'re ready! Try:');
    console.log('  npm run dev -- run "Check for available updates"');
    console.log('  npm run dev -- server  (open http://localhost:3000)\n');

    // Trigger an initial memory scan
    console.log('Running initial site scan to populate memory...');
    try {
      const { Orchestrator } = await import('./agents/orchestrator');
      const orchestrator = new Orchestrator(config);
      await orchestrator.run('Initial setup scan: get WordPress version, PHP version, list all plugins with versions and active status, list all themes. Store all findings.');
      console.log('\x1b[32m✓ Initial scan complete. Memory populated.\x1b[0m\n');
    } catch (err) {
      console.log('\x1b[33m⚠  Initial scan failed (non-critical): ' + err + '\x1b[0m\n');
    }

    return true;
  } else {
    console.log(`\x1b[31m✗ ${failures.length} critical check(s) failed. Fix the issues above before running tasks.\x1b[0m\n`);
    return false;
  }
}

// Run directly
if (require.main === module) {
  runSetupCheck().then(ok => process.exit(ok ? 0 : 1));
}
