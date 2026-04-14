// src/cli.ts
import { Command } from 'commander';
import inquirer from 'inquirer';
import { loadSiteConfig, bus } from './config';
import { Orchestrator } from './agents/orchestrator';
import { listTasks, getTask, listPendingApprovals, resolveApproval } from './memory/store';

const program = new Command();

program
  .name('wp-agent')
  .description('Agentic WordPress maintenance system powered by Claude')
  .version('1.0.0');

// ─── Run a task ───────────────────────────────────────────────

program
  .command('run [task]')
  .description('Run a WordPress maintenance task')
  .option('-i, --interactive', 'Enter task interactively')
  .action(async (task: string | undefined, opts: { interactive?: boolean }) => {
    const config = loadSiteConfig();

    let taskDescription = task;

    if (!taskDescription || opts.interactive) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'task',
          message: 'What would you like me to do?',
          validate: (v: string) => v.length > 5 || 'Please describe the task',
        },
      ]);
      taskDescription = answers.task;
    }

    const orchestrator = new Orchestrator(config);
    const result = await orchestrator.run(taskDescription!);

    console.log('\n━━━ Result ━━━');
    console.log(`Status : ${result.status}`);
    console.log(`Steps  : ${result.steps.length}`);
    if (result.result)  console.log(`Output : ${result.result}`);
    if (result.error)   console.log(`Error  : ${result.error}`);
  });

// ─── Task history ─────────────────────────────────────────────

program
  .command('history')
  .description('Show recent task history')
  .option('-n, --limit <n>', 'Number of tasks to show', '20')
  .action((opts: { limit: string }) => {
    const tasks = listTasks(parseInt(opts.limit));
    if (!tasks.length) {
      console.log('No tasks found.');
      return;
    }
    console.log('\nTask History:');
    console.log('─'.repeat(80));
    for (const task of tasks) {
      const statusColor = task.status === 'completed' ? '\x1b[32m'
        : task.status === 'failed' ? '\x1b[31m' : '\x1b[33m';
      const reset = '\x1b[0m';
      console.log(
        `${statusColor}[${task.status.toUpperCase().padEnd(10)}]${reset} ` +
        `${task.createdAt.slice(0, 16).replace('T', ' ')}  ` +
        `${task.description.slice(0, 60)}`
      );
    }
  });

// ─── Show task details ────────────────────────────────────────

program
  .command('task <id>')
  .description('Show details of a specific task')
  .action((id: string) => {
    const task = getTask(id);
    if (!task) {
      console.error('Task not found:', id);
      return;
    }
    console.log('\n' + JSON.stringify(task, null, 2));
  });

// ─── Pending approvals ────────────────────────────────────────

program
  .command('approvals')
  .description('Review and resolve pending approval requests')
  .action(async () => {
    const pending = listPendingApprovals();
    if (!pending.length) {
      console.log('No pending approvals.');
      return;
    }

    for (const req of pending) {
      console.log('\n' + '─'.repeat(60));
      console.log(`ID      : ${req.id}`);
      console.log(`Task    : ${req.taskId}`);
      console.log(`Action  : ${req.action}`);
      console.log(`Risk    : ${req.risk.toUpperCase()}`);
      console.log(`Details : ${JSON.stringify(req.details, null, 2)}`);

      const { decision } = await inquirer.prompt([{
        type: 'list',
        name: 'decision',
        message: 'Approve or deny this action?',
        choices: ['approve', 'deny', 'skip'],
      }]);

      if (decision !== 'skip') {
        resolveApproval(req.id, decision === 'approve');
        console.log(decision === 'approve' ? '✓ Approved' : '✗ Denied');
      }
    }
  });

// ─── Quick commands ───────────────────────────────────────────

program
  .command('update')
  .description('Update all plugins, themes, and WordPress core')
  .action(async () => {
    const config = loadSiteConfig();
    const orchestrator = new Orchestrator(config);
    await orchestrator.run('Update all WordPress plugins, themes, and core to their latest versions. Check for updates first, then update safely with maintenance mode enabled.');
  });

program
  .command('test')
  .description('Run a full site test (browser-based)')
  .action(async () => {
    const config = loadSiteConfig();
    const orchestrator = new Orchestrator(config);
    await orchestrator.run('Run a comprehensive site test: check all main pages, test admin, check for broken links, measure load times on key pages, take screenshots of homepage and key pages.');
  });

program
  .command('debug')
  .description('Read error logs and fix any issues found')
  .action(async () => {
    const config = loadSiteConfig();
    const orchestrator = new Orchestrator(config);
    await orchestrator.run('Read the WordPress error logs and PHP error logs. Identify any current errors. For each error, trace it to its source and apply a fix.');
  });

program
  .command('scan')
  .description('Scan the site and update memory (plugins, themes, versions)')
  .action(async () => {
    const config = loadSiteConfig();
    const orchestrator = new Orchestrator(config);
    await orchestrator.run('Scan the WordPress installation: get WordPress version, PHP version, list all plugins with versions and active status, list themes, check for any available updates. Record all findings.');
  });

program
  .command('server')
  .description('Start the web dashboard')
  .action(async () => {
    const { startServer } = await import('./server');
    startServer();
  });

program
  .command('setup')
  .description('Verify SSH, WP-CLI, REST API, and Playwright connectivity')
  .action(async () => {
    const { runSetupCheck } = await import('./setup');
    await runSetupCheck();
  });

program
  .command('audit')
  .description('Run a comprehensive site audit (security, performance, content, versions)')
  .action(async () => {
    const config = loadSiteConfig();
    const orchestrator = new Orchestrator(config);
    await orchestrator.run('Run a full site audit: WordPress version, PHP version, all plugins and their update status, themes, content counts, images missing alt text, security checks (debug mode, file editor), performance (homepage load time), error logs. Produce a complete health report with critical issues, warnings, and recommendations.');
  });

program
  .command('promote')
  .description('Promote staging → production (runs tests on staging first)')
  .option('--sync-db', 'Also sync the database (DANGER: overwrites production content)')
  .action(async (opts: { syncDb?: boolean }) => {
    const config = loadSiteConfig();

    if (!config.stagingUrl) {
      console.error('No staging environment configured. Set STAGING_URL in .env');
      process.exit(1);
    }

    const { approved } = await inquirer.prompt([{
      type: 'confirm',
      name: 'approved',
      message: `Promote staging (${config.stagingUrl}) → production (${config.url})?\nThis will sync theme/plugin files and flush caches.${opts.syncDb ? '\n⚠️  --sync-db flag is set: production database will be OVERWRITTEN.' : ''}`,
      default: false,
    }]);

    if (!approved) { console.log('Promotion cancelled.'); return; }

    const { promoteToProduction } = await import('./tools/promote');
    const result = await promoteToProduction(config, { syncDatabase: !!opts.syncDb });

    console.log('\n' + result.log.join('\n'));
    console.log(result.success ? '\n✓ Promotion successful' : '\n✗ Promotion failed');
  });

program
  .command('perf')
  .description('Run a full performance audit and optimise what can be done automatically')
  .action(async () => {
    const config = loadSiteConfig();
    const orchestrator = new Orchestrator(config);
    await orchestrator.run('Run a full performance optimisation: measure Core Web Vitals on the homepage and key pages, clean the database (revisions, transients, spam), audit images for missing alt text, check caching configuration. For each issue found, fix what can be fixed automatically and report recommendations for the rest.');
  });

program
  .command('schedule')
  .description('Show the automated maintenance schedule')
  .action(async () => {
    const { Scheduler } = await import('./scheduler');
    const sched = new Scheduler();
    const status = sched.getStatus();
    console.log('\nMaintenance Schedule:');
    console.log('─'.repeat(70));
    for (const entry of status) {
      const icon = entry.enabled ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m';
      const due = entry.isDue ? '\x1b[33m (DUE)\x1b[0m' : '';
      console.log(`${icon}  ${entry.name.padEnd(22)} ${entry.cronExpression.padEnd(10)} next: ${entry.nextRun?.slice(0,16) || 'now'}${due}`);
    }
    console.log('\nStart the server to run the scheduler: npm run dev -- server');
  });

program.parseAsync(process.argv).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
