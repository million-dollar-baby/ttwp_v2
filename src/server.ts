// src/server.ts
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { loadSiteConfig, DASHBOARD_PORT, bus } from './config';
import { Orchestrator } from './agents/orchestrator';
import { Scheduler } from './scheduler';
import { Notifier } from './notifier';
import { handleChatMessage, getWelcomeMessage, isSetupDone, loadSetup } from './chat';
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

// POST /api/tasks — create and run a task
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

  // Send welcome on connect
  const welcome = getWelcomeMessage(isSetupDone(), loadSetup().siteName);
  socket.emit('chat:message', welcome);
  socket.emit('chat:setup_status', { complete: isSetupDone(), siteName: loadSetup().siteName });

  // User sends a chat message
  socket.on('chat:send', async (data: { text: string }) => {
    if (!data?.text?.trim()) return;
    await handleChatMessage(socket.id, data.text.trim(), io);
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
