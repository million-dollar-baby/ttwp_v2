// src/server.ts
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { NodeSSH } from 'node-ssh';
import { loadSiteConfig, DASHBOARD_PORT, bus } from './config';
import { Orchestrator } from './agents/orchestrator';
import { Scheduler } from './scheduler';
import { Notifier } from './notifier';
import {
  handleChatMessage, getWelcomeMessage, isSetupDone, loadSetup,
  saveSiteById, loadSiteById, loadSiteIntoSession, isSiteSetupDone,
  SiteSetup,
} from './chat';
import { resolveApproval, listTasks, getTask, listPendingApprovals } from './memory/store';

const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'dashboard')));

// ─── Forward all bus events to connected browsers ─────────────

bus.on('event', (event) => {
  io.emit('event', event);
});
bus.on('log', (entry) => {
  io.emit('log', entry);
});

// ─── REST API ─────────────────────────────────────────────────

// POST /api/sites/register — called from frontend when user adds a site
// Saves SSH + WP credentials to data/sites/{id}.json on the server
app.post('/api/sites/register', (req, res) => {
  const body = req.body as {
    id?: string; url?: string; name?: string; domain?: string;
    sshHost?: string; sshPort?: number; sshUser?: string;
    sshPassword?: string; sshKeyPath?: string; wpPath?: string;
    wpUser?: string; wpAppPassword?: string;
  };

  if (!body.id || !body.url || !body.sshHost || !body.sshUser) {
    res.status(400).json({ error: 'id, url, sshHost, sshUser are required' });
    return;
  }

  const cfg: SiteSetup = {
    id:             body.id,
    wpUrl:          body.url.replace(/\/$/, ''),
    wpUser:         body.wpUser     || 'admin',
    wpAppPassword:  body.wpAppPassword || '',
    sshHost:        body.sshHost,
    sshPort:        body.sshPort    || 22,
    sshUser:        body.sshUser,
    sshPassword:    body.sshPassword || '',
    sshKeyPath:     body.sshKeyPath  || '',
    wpPath:         body.wpPath      || '/var/www/html',
    siteName:       body.name        || body.domain || body.url,
    domain:         body.domain      || '',
    setupComplete:  true,
  };

  saveSiteById(body.id, cfg);
  bus.log('info', `Site registered: ${body.domain || body.url} (id: ${body.id})`, 'orchestrator');
  res.json({ ok: true, siteId: body.id });
});

// GET /api/sites/:id/status — check if a site has been registered
app.get('/api/sites/:id/status', (req, res) => {
  const cfg = loadSiteById(req.params.id);
  if (!cfg) {
    res.json({ registered: false });
    return;
  }
  res.json({
    registered: true,
    setupComplete: cfg.setupComplete || false,
    siteName: cfg.siteName || cfg.domain || cfg.wpUrl,
    wpUrl: cfg.wpUrl,
  });
});

// ─── REAL onboarding flow ─────────────────────────────────────
// Uses SSH to: verify connection, find WP install, ensure WP-CLI,
// detect admin user, auto-create application password, extract DB creds.
// User never has to provide WP credentials manually.
//
// POST /api/sites/onboard
// Body: { id, url, label?, category?, sshHost, sshPort, sshUser, sshPassword?, sshKey?, clientId? }
// `clientId` is the socket.id — we stream progress to that socket.

interface OnboardBody {
  id?: string;
  url?: string;
  label?: string;
  category?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshPassword?: string;
  sshKey?: string;        // path to private key
  clientId?: string;      // socket.id to stream progress to
}

interface OnboardResult {
  ok: boolean;
  siteId?: string;
  wpUser?: string;
  wpVersion?: string;
  wpPath?: string;
  error?: string;
}

function emitOnboardStep(
  clientId: string | undefined,
  step: number,
  status: 'run' | 'ok' | 'fail',
  message: string,
  detail?: string,
): void {
  if (!clientId) return;
  const payload = { step, status, message, detail };
  io.to(clientId).emit('onboard:step', payload);
}

async function runOnboardingFlow(body: OnboardBody): Promise<OnboardResult> {
  const clientId = body.clientId;
  const ssh = new NodeSSH();

  try {
    // ── Step 1: SSH connect ──────────────────────────────────
    emitOnboardStep(clientId, 1, 'run', 'Connecting via SSH…');

    const sshOpts: Parameters<NodeSSH['connect']>[0] = {
      host: body.sshHost!,
      port: body.sshPort || 22,
      username: body.sshUser!,
      readyTimeout: 15000,
    };
    if (body.sshPassword) {
      sshOpts.password = body.sshPassword;
    } else if (body.sshKey) {
      sshOpts.privateKeyPath = body.sshKey;
    }

    try {
      await ssh.connect(sshOpts);
    } catch (err) {
      emitOnboardStep(clientId, 1, 'fail', 'SSH connection failed', String(err));
      return { ok: false, error: `SSH connection failed: ${err}` };
    }
    emitOnboardStep(clientId, 1, 'ok', `Connected to ${body.sshHost}`);

    // ── Step 2: Find WordPress install ───────────────────────
    emitOnboardStep(clientId, 2, 'run', 'Locating WordPress install…');

    const findWp = await ssh.execCommand(
      `find /var/www /home /srv /opt -name wp-config.php 2>/dev/null | head -1`,
    );
    const wpConfigPath = findWp.stdout.trim();
    if (!wpConfigPath) {
      emitOnboardStep(clientId, 2, 'fail', 'WordPress not found on server',
        'Searched /var/www, /home, /srv, /opt — no wp-config.php found');
      ssh.dispose();
      return { ok: false, error: 'No wp-config.php found on server.' };
    }
    const wpPath = wpConfigPath.replace('/wp-config.php', '');

    // Get WP version
    const wpVersionCmd = await ssh.execCommand(
      `grep "wp_version =" ${wpPath}/wp-includes/version.php 2>/dev/null | head -1`,
    );
    const wpVersionMatch = wpVersionCmd.stdout.match(/['"]([^'"]+)['"]/);
    const wpVersion = wpVersionMatch?.[1] || 'unknown';
    emitOnboardStep(clientId, 2, 'ok', `WordPress ${wpVersion} found at ${wpPath}`);

    // ── Step 3: Ensure WP-CLI ────────────────────────────────
    emitOnboardStep(clientId, 3, 'run', 'Checking WP-CLI…');

    let wpCliCmd = 'wp'; // default if installed system-wide
    const wpCheck = await ssh.execCommand('which wp 2>/dev/null');
    if (!wpCheck.stdout.trim()) {
      // Try to install WP-CLI as a phar in user's home
      emitOnboardStep(clientId, 3, 'run', 'WP-CLI not found — installing…');
      const installCmd = await ssh.execCommand(
        `cd ~ && curl -sLO https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar && chmod +x wp-cli.phar && echo "OK" || echo "FAIL"`,
      );
      if (!installCmd.stdout.includes('OK')) {
        emitOnboardStep(clientId, 3, 'fail', 'WP-CLI install failed',
          'Server may not have curl or internet access. ' + (installCmd.stderr || ''));
        ssh.dispose();
        return { ok: false, error: 'Could not install WP-CLI on server.' };
      }
      wpCliCmd = 'php ~/wp-cli.phar';
      emitOnboardStep(clientId, 3, 'ok', 'WP-CLI installed');
    } else {
      emitOnboardStep(clientId, 3, 'ok', `WP-CLI ready (${wpCheck.stdout.trim()})`);
    }

    const wp = (args: string) =>
      ssh.execCommand(`${wpCliCmd} ${args} --path=${wpPath} --allow-root 2>&1`);

    // ── Step 4: Detect admin user ────────────────────────────
    emitOnboardStep(clientId, 4, 'run', 'Finding admin user…');

    const userListCmd = await wp(
      `user list --role=administrator --field=user_login --format=csv`,
    );
    // Output may include header "user_login" then list of admins
    const adminLines = userListCmd.stdout
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && l !== 'user_login' && !l.startsWith('Error') && !l.startsWith('PHP'));
    const wpUser = adminLines[0];
    if (!wpUser) {
      emitOnboardStep(clientId, 4, 'fail', 'No admin user found',
        userListCmd.stdout.slice(0, 200));
      ssh.dispose();
      return { ok: false, error: 'Could not detect WordPress administrator.' };
    }
    emitOnboardStep(clientId, 4, 'ok', `Admin user: ${wpUser}`);

    // ── Step 5: Create application password ──────────────────
    emitOnboardStep(clientId, 5, 'run', 'Generating application password…');

    // Use a unique app name so re-onboarding doesn't collide
    const appName = `TalkToWP-${Date.now()}`;
    const apCmd = await wp(
      `user application-password create "${wpUser}" "${appName}" --porcelain`,
    );
    const wpAppPassword = apCmd.stdout.trim().split('\n').pop()?.trim() || '';
    if (!wpAppPassword || wpAppPassword.includes('Error') || wpAppPassword.length < 10) {
      emitOnboardStep(clientId, 5, 'fail', 'Could not generate app password',
        apCmd.stdout.slice(0, 200));
      ssh.dispose();
      return { ok: false, error: 'Failed to create WP application password.' };
    }
    emitOnboardStep(clientId, 5, 'ok', 'Application password created');

    // ── Step 6: Extract DB credentials ───────────────────────
    emitOnboardStep(clientId, 6, 'run', 'Reading wp-config.php…');

    const dbGrep = await ssh.execCommand(
      `grep -E "define.*DB_(NAME|USER|PASSWORD|HOST)" "${wpConfigPath}" 2>/dev/null`,
    );
    const extractDb = (key: string): string => {
      const m = dbGrep.stdout.match(new RegExp(`DB_${key}['"\\s,]+['"](.*?)['"]`));
      return m?.[1] || '';
    };
    const dbName = extractDb('NAME');
    const dbUser = extractDb('USER');
    const dbPassword = extractDb('PASSWORD');
    const dbHost = extractDb('HOST') || 'localhost';
    emitOnboardStep(clientId, 6, 'ok',
      dbName ? `Database: ${dbName}` : 'wp-config.php read (DB creds skipped)');

    ssh.dispose();

    // ── Step 7: Save site ────────────────────────────────────
    emitOnboardStep(clientId, 7, 'run', 'Saving site…');

    const domain = (body.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    const siteId = body.id || 's' + Date.now();
    const cfg: SiteSetup = {
      id:             siteId,
      wpUrl:          (body.url || '').replace(/\/$/, ''),
      wpUser,
      wpAppPassword,
      sshHost:        body.sshHost!,
      sshPort:        body.sshPort || 22,
      sshUser:        body.sshUser!,
      sshPassword:    body.sshPassword || '',
      sshKeyPath:     body.sshKey || '',
      wpPath,
      dbHost, dbName, dbUser, dbPassword,
      dbExtracted:    !!dbName,
      siteName:       body.label || domain,
      domain,
      setupComplete:  true,
    };
    saveSiteById(siteId, cfg);
    emitOnboardStep(clientId, 7, 'ok', 'Site ready');

    bus.log('success',
      `Site onboarded: ${domain} (WP ${wpVersion}, admin: ${wpUser}) — id: ${siteId}`,
      'orchestrator');

    return {
      ok: true,
      siteId,
      wpUser,
      wpVersion,
      wpPath,
    };
  } catch (err) {
    try { ssh.dispose(); } catch { /* ignore */ }
    emitOnboardStep(clientId, 0, 'fail', 'Onboarding failed', String(err));
    bus.log('error', `Onboarding error: ${err}`, 'orchestrator');
    return { ok: false, error: String(err) };
  }
}

app.post('/api/sites/onboard', async (req, res) => {
  const body = req.body as OnboardBody;
  if (!body.url || !body.sshHost || !body.sshUser) {
    res.status(400).json({ ok: false, error: 'url, sshHost, sshUser are required' });
    return;
  }
  if (!body.sshPassword && !body.sshKey) {
    res.status(400).json({ ok: false, error: 'Either sshPassword or sshKey is required' });
    return;
  }

  const result = await runOnboardingFlow(body);
  if (result.ok) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
});
app.post('/api/tasks', async (req, res) => {
  const { description } = req.body as { description?: string };
  if (!description) {
    res.status(400).json({ error: 'description is required' });
    return;
  }

  try {
    const config = loadSiteConfig();
    const orchestrator = new Orchestrator(config);

    // Run async — return task ID immediately
    const task = {
      id: require('uuid').v4(),
      description,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
    };

    res.json({ taskId: task.id, message: 'Task queued' });

    // Run in background
    orchestrator.run(description).catch(err => {
      bus.log('error', `Background task failed: ${err.message}`, 'orchestrator');
    });

  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/tasks — list recent tasks
app.get('/api/tasks', (_req, res) => {
  res.json(listTasks(50));
});

// GET /api/tasks/:id — get task detail
app.get('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(task);
});

// GET /api/approvals — list pending approvals
app.get('/api/approvals', (_req, res) => {
  res.json(listPendingApprovals());
});

// POST /api/approvals/:id — resolve approval
app.post('/api/approvals/:id', (req, res) => {
  const { approved } = req.body as { approved: boolean };
  resolveApproval(req.params.id, approved);
  res.json({ ok: true });
});

// ─── Scheduler endpoints ──────────────────────────────────────

let scheduler: Scheduler | null = null;

app.get('/api/schedule', (_req, res) => {
  res.json(scheduler?.getStatus() || []);
});

app.post('/api/schedule/:id/run', async (req, res) => {
  try {
    await scheduler?.runNow(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: String(err) });
  }
});

app.post('/api/schedule/:id/enable',  (req, res) => { scheduler?.enableTask(req.params.id);  res.json({ ok: true }); });
app.post('/api/schedule/:id/disable', (req, res) => { scheduler?.disableTask(req.params.id); res.json({ ok: true }); });

// ─── WebSocket ────────────────────────────────────────────────

io.on('connection', (socket) => {
  bus.log('debug', `Client connected: ${socket.id}`, 'orchestrator');

  // ── Chat interface events ──────────────────────────────────

  // Send welcome on connect (site-specific status sent via chat:load_site handler)
  const welcome = getWelcomeMessage(isSetupDone(), loadSetup().siteName);
  socket.emit('chat:message', welcome);

  // Client tells us which site it's working on (called from index.html on load)
  socket.on('chat:load_site', (data: { siteId: string }) => {
    if (!data?.siteId) return;

    const loaded = loadSiteIntoSession(socket.id, data.siteId);
    if (loaded) {
      const cfg = loadSiteById(data.siteId);
      const siteName = cfg?.siteName || cfg?.domain || cfg?.wpUrl || 'your site';

      // Tell frontend the site is ready
      socket.emit('chat:setup_status', {
        complete: true,
        siteName,
      });

      // Replace the generic welcome with a site-specific one
      const siteWelcome = getWelcomeMessage(true, siteName);
      socket.emit('chat:message', siteWelcome);

      bus.log('debug', `Session ${socket.id} loaded site: ${data.siteId} (${siteName})`, 'orchestrator');
    } else {
      // Site not yet registered on backend (e.g. after Railway redeploy wipes data/)
      socket.emit('chat:setup_status', { complete: false, siteName: null, needsRegister: true });
      bus.log('warn', `Site ${data.siteId} not found in backend storage — needsRegister`, 'orchestrator');
    }
  });

  // User sends a chat message — now passes siteId too
  socket.on('chat:send', async (data: { text: string; siteId?: string }) => {
    if (!data?.text?.trim()) return;
    await handleChatMessage(socket.id, data.text.trim(), io, data.siteId);
  });

  // User resolves an approval from inside chat
  socket.on('chat:approve', (data: { id: string; approved: boolean }) => {
    resolveApproval(data.id, data.approved);
    io.emit('approval_resolved', data);
    const msg = data.approved
      ? { id: data.id, role: 'user', content: '✅ Approved', timestamp: new Date().toISOString(), type: 'text' }
      : { id: data.id, role: 'user', content: '❌ Denied', timestamp: new Date().toISOString(), type: 'text' };
    socket.emit('chat:message', msg);
  });

  // ── Legacy dashboard events (kept for backwards compat) ───

  socket.emit('init', { tasks: listTasks(20) });

  socket.on('run_task', async (data: { description: string }) => {
    try {
      const config = loadSiteConfig();
      const orchestrator = new Orchestrator(config);
      orchestrator.run(data.description).catch(err => {
        bus.log('error', `Task error: ${err.message}`, 'orchestrator');
      });
    } catch (err) {
      socket.emit('error', { message: String(err) });
    }
  });

  socket.on('resolve_approval', (data: { id: string; approved: boolean }) => {
    resolveApproval(data.id, data.approved);
    io.emit('approval_resolved', data);
  });

  socket.on('agent:kill', () => {
    bus.log('warn', `Kill switch activated by client ${socket.id}`, 'orchestrator');
    scheduler?.stop();
    // Re-start scheduler after brief pause so it can be resumed
    setTimeout(() => scheduler?.start(60_000), 500);
  });

  socket.on('agent:pause', () => {
    bus.log('info', `Agent paused by client ${socket.id}`, 'orchestrator');
    scheduler?.stop();
  });

  socket.on('agent:resume', () => {
    bus.log('info', `Agent resumed by client ${socket.id}`, 'orchestrator');
    scheduler?.start(60_000);
  });

  socket.on('disconnect', () => {
    bus.log('debug', `Client disconnected: ${socket.id}`, 'orchestrator');
  });
});

export function startServer(): void {
  // Init notifier (attaches to bus events)
  const notifier = new Notifier();
  if (notifier.isConfigured()) {
    bus.log('info', 'Notifications configured (Slack/email)', 'orchestrator');
  }

  // Init scheduler
  scheduler = new Scheduler();
  scheduler.start(60_000); // check every minute

  httpServer.listen(DASHBOARD_PORT, () => {
    console.log(`\x1b[32m✓ WP Agent dashboard running at http://localhost:${DASHBOARD_PORT}\x1b[0m`);
    console.log(`\x1b[32m✓ Scheduler running (${scheduler!.getStatus().filter(s => s.enabled).length} active tasks)\x1b[0m`);
  });
}

// Run directly if called as main
if (require.main === module) {
  startServer();
}
