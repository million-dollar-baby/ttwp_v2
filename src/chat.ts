// src/chat.ts
// Powers the Claude-style chat interface.
// Handles two modes:
//   1. ONBOARDING — walks user through setup conversationally
//   2. AGENT — routes messages to the orchestrator and streams progress

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { NodeSSH } from 'node-ssh';
import { Server as SocketIO } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { ANTHROPIC_API_KEY, MODEL, bus } from './config';
import { Orchestrator } from './agents/orchestrator';
import { loadSiteConfig } from './config';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Config storage (replaces .env for UI users) ──────────────

const CONFIG_PATH = path.join(process.cwd(), 'data', 'site-config.json');

export interface SiteSetup {
  wpUrl?: string;
  wpUser?: string;
  wpAppPassword?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshPassword?: string;
  wpPath?: string;
  stagingUrl?: string;
  gitRepoUrl?: string;
  slackWebhookUrl?: string;
  siteName?: string;
  setupComplete?: boolean;
  setupStep?: string; // which step we're on
}

export function loadSetup(): SiteSetup {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}

export function saveSetup(cfg: SiteSetup): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function isSetupDone(): boolean {
  const s = loadSetup();
  return !!(s.setupComplete && s.wpUrl && s.wpAppPassword && s.sshHost);
}

function applySetupToEnv(cfg: SiteSetup): void {
  if (cfg.wpUrl)          process.env.WP_URL           = cfg.wpUrl;
  if (cfg.wpUser)         process.env.WP_USER          = cfg.wpUser;
  if (cfg.wpAppPassword)  process.env.WP_APP_PASSWORD  = cfg.wpAppPassword;
  if (cfg.sshHost)        process.env.SSH_HOST         = cfg.sshHost;
  if (cfg.sshUser)        process.env.SSH_USER         = cfg.sshUser;
  if (cfg.wpPath)         process.env.WP_PATH          = cfg.wpPath;
  process.env.SSH_PORT     = String(cfg.sshPort || 22);
  process.env.SSH_KEY_PATH = process.env.SSH_KEY_PATH || '/root/.ssh/id_rsa';
  process.env.DB_NAME      = process.env.DB_NAME     || 'wordpress';
  process.env.DB_USER      = process.env.DB_USER     || 'root';
  process.env.DB_PASSWORD  = process.env.DB_PASSWORD || '';
  process.env.DB_HOST      = process.env.DB_HOST     || 'localhost';
}

// ─── Connection testers ───────────────────────────────────────

async function testWordPress(url: string, user: string, pass: string): Promise<{ ok: boolean; siteName?: string; error?: string }> {
  try {
    const res = await axios.get(`${url.replace(/\/$/, '')}/wp-json/wp/v2/settings`, {
      auth: { username: user, password: pass }, timeout: 12000,
    });
    return { ok: true, siteName: res.data.title };
  } catch (e: unknown) {
    const err = e as { response?: { status: number } };
    if (err.response?.status === 401) return { ok: false, error: 'Wrong username or password. Double-check your Application Password.' };
    if (err.response?.status === 404) return { ok: false, error: "REST API not found. Make sure WordPress is installed at that URL and pretty permalinks are enabled." };
    return { ok: false, error: `Can't reach ${url}. Is the URL correct and the site online?` };
  }
}

async function testSSH(host: string, port: number, user: string, password?: string): Promise<{ ok: boolean; wpCliFound?: boolean; wpPath?: string; error?: string }> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host, port: port || 22, username: user, password, readyTimeout: 15000 });
    const wpCheck = await ssh.execCommand('which wp 2>/dev/null || wp --info --allow-root 2>/dev/null | head -1');
    const wpCliFound = wpCheck.stdout.includes('wp') || wpCheck.stdout.includes('WP-CLI');
    // Try to find wp-config.php
    const findWp = await ssh.execCommand('find /var/www /home /srv /opt -name wp-config.php 2>/dev/null | head -3');
    const wpPath = findWp.stdout.trim().split('\n')[0]?.replace('/wp-config.php', '') || '/var/www/html';
    ssh.dispose();
    return { ok: true, wpCliFound, wpPath };
  } catch (e) {
    ssh.dispose();
    return { ok: false, error: `SSH connection failed: ${e}` };
  }
}

// ─── Chat message types ───────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  // special UI hints
  type?: 'text' | 'approval' | 'task_update' | 'success' | 'error' | 'link_card';
  meta?: Record<string, unknown>;
}

export interface ChatSession {
  id: string;
  messages: ChatMessage[];
  setup: SiteSetup;
  createdAt: string;
}

// In-memory sessions (keyed by socket id)
const sessions = new Map<string, ChatSession>();

function getOrCreateSession(socketId: string): ChatSession {
  if (!sessions.has(socketId)) {
    sessions.set(socketId, {
      id: socketId,
      messages: [],
      setup: loadSetup(),
      createdAt: new Date().toISOString(),
    });
  }
  return sessions.get(socketId)!;
}

// ─── Onboarding system prompt ─────────────────────────────────

const ONBOARDING_PROMPT = `You are WP Agent — a friendly AI assistant that helps people set up and maintain their WordPress websites.

You are currently in ONBOARDING MODE. The user needs to connect their WordPress site.

Your job is to collect this information, one step at a time, conversationally:
1. WordPress site URL
2. WordPress username + Application Password (explain how to create one if they don't know)
3. SSH server details (host, username, password OR tell them about SSH keys)
4. WordPress installation path on server (you can auto-detect this)
5. Optionally: GitHub repo, staging URL, Slack webhook

PERSONALITY:
- Friendly, clear, patient — many users are non-technical
- One question at a time — don't overwhelm
- Explain WHY you need each piece of info
- When something works, celebrate it briefly
- When something fails, give a clear fix

SPECIAL INSTRUCTIONS:
- When you have enough info to test a connection, say exactly: [TEST_WP] or [TEST_SSH]
- When you want to save collected data, output a JSON block like: [SAVE]{"wpUrl":"..."}[/SAVE]  
- When setup is complete, say exactly: [SETUP_COMPLETE]
- When you want to show a link/button, use: [LINK text|url]
- When you want to show a quick reply chip, use: [CHIP text]

CURRENT SETUP STATE:
{SETUP_STATE}`;

// ─── Main agent system prompt ─────────────────────────────────

const AGENT_PROMPT = `You are WP Agent — an AI WordPress maintenance assistant.

The user's site is connected and ready. You can run any WordPress maintenance task.

SITE INFO:
{SITE_INFO}

CAPABILITIES:
- Update plugins, themes, WordPress core
- Fix bugs and PHP errors
- Create/edit pages and posts
- Test the site like a real user (browser automation)
- Full site audit and health report
- Performance optimisation
- Set up GitHub backups
- Promote staging → production

PERSONALITY: Confident, clear, efficient. Tell the user what you're doing as you do it.

SPECIAL INSTRUCTIONS:
- When you want to run a task, say: [RUN_TASK]description of task[/RUN_TASK]
- For quick reply chips: [CHIP text]
- For links: [LINK text|url]
- When asking for approval: [APPROVAL id|action description]`;

// ─── Parse special tokens from AI response ───────────────────

interface ParsedResponse {
  text: string;
  actions: Array<{ type: string; value: string; extra?: string }>;
}

function parseResponse(raw: string): ParsedResponse {
  const actions: ParsedResponse['actions'] = [];
  let text = raw;

  // [RUN_TASK]...[/RUN_TASK]
  text = text.replace(/\[RUN_TASK\]([\s\S]*?)\[\/RUN_TASK\]/g, (_, v) => {
    actions.push({ type: 'run_task', value: v.trim() });
    return '';
  });

  // [SAVE]{...}[/SAVE]
  text = text.replace(/\[SAVE\]([\s\S]*?)\[\/SAVE\]/g, (_, v) => {
    actions.push({ type: 'save', value: v.trim() });
    return '';
  });

  // [TEST_WP] / [TEST_SSH]
  if (text.includes('[TEST_WP]')) { actions.push({ type: 'test_wp', value: '' }); text = text.replace('[TEST_WP]', ''); }
  if (text.includes('[TEST_SSH]')) { actions.push({ type: 'test_ssh', value: '' }); text = text.replace('[TEST_SSH]', ''); }
  if (text.includes('[SETUP_COMPLETE]')) { actions.push({ type: 'setup_complete', value: '' }); text = text.replace('[SETUP_COMPLETE]', ''); }

  // [CHIP text]
  text = text.replace(/\[CHIP ([^\]]+)\]/g, (_, v) => {
    actions.push({ type: 'chip', value: v.trim() });
    return '';
  });

  // [LINK text|url]
  text = text.replace(/\[LINK ([^|]+)\|([^\]]+)\]/g, (_, label, url) => {
    actions.push({ type: 'link', value: label.trim(), extra: url.trim() });
    return `[🔗 ${label.trim()}]`;
  });

  return { text: text.trim(), actions };
}

// ─── Core chat handler (called per socket message) ────────────

export async function handleChatMessage(
  socketId: string,
  userText: string,
  io: SocketIO,
): Promise<void> {
  const session = getOrCreateSession(socketId);
  const socket = io.sockets.sockets.get(socketId);
  if (!socket) return;

  // Add user message to history
  session.messages.push({
    id: uuidv4(), role: 'user', content: userText,
    timestamp: new Date().toISOString(),
  });

  const isOnboarding = !isSetupDone();

  // Build system prompt
  let systemPrompt: string;
  if (isOnboarding) {
    const setupState = JSON.stringify(session.setup, null, 2);
    systemPrompt = ONBOARDING_PROMPT.replace('{SETUP_STATE}', setupState);
  } else {
    const cfg = loadSetup();
    applySetupToEnv(cfg);
    const siteInfo = `URL: ${cfg.wpUrl}\nSite name: ${cfg.siteName || 'unknown'}\nSSH: ${cfg.sshUser}@${cfg.sshHost}`;
    systemPrompt = AGENT_PROMPT.replace('{SITE_INFO}', siteInfo);
  }

  // Build message history for Claude
  const history = session.messages.slice(-20).map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // ── Stream response from Claude ───────────────────────────
  socket.emit('chat:typing', true);

  let fullText = '';

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: history,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        fullText += chunk.delta.text;
        socket.emit('chat:chunk', { text: chunk.delta.text });
      }
    }

    socket.emit('chat:typing', false);

    // ── Parse and execute actions ─────────────────────────
    const parsed = parseResponse(fullText);

    // Emit the final cleaned message
    const assistantMsg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: parsed.text,
      timestamp: new Date().toISOString(),
      type: 'text',
      meta: {
        chips: parsed.actions.filter(a => a.type === 'chip').map(a => a.value),
        links: parsed.actions.filter(a => a.type === 'link').map(a => ({ label: a.value, url: a.extra })),
      },
    };
    session.messages.push(assistantMsg);
    socket.emit('chat:message', assistantMsg);

    // ── Process each action ───────────────────────────────
    for (const action of parsed.actions) {

      if (action.type === 'save') {
        try {
          const data = JSON.parse(action.value);
          session.setup = { ...session.setup, ...data };
          saveSetup(session.setup);
        } catch { /* ignore bad JSON */ }
      }

      if (action.type === 'test_wp') {
        const cfg = session.setup;
        socket.emit('chat:status', { text: 'Testing WordPress connection…' });
        const result = await testWordPress(cfg.wpUrl!, cfg.wpUser!, cfg.wpAppPassword!);
        if (result.ok) {
          session.setup.siteName = result.siteName;
          saveSetup(session.setup);
          const msg = buildAssistantMsg(`✅ Connected! Found your site: **${result.siteName}**\n\nNow let's connect to your server so I can actually do maintenance work.`);
          session.messages.push(msg);
          socket.emit('chat:message', msg);
        } else {
          const msg = buildAssistantMsg(`❌ ${result.error}\n\nLet's try again — paste your site URL (e.g. https://yoursite.com)`);
          session.messages.push(msg);
          socket.emit('chat:message', msg);
        }
      }

      if (action.type === 'test_ssh') {
        const cfg = session.setup;
        socket.emit('chat:status', { text: 'Testing SSH connection…' });
        const result = await testSSH(cfg.sshHost!, cfg.sshPort || 22, cfg.sshUser!, cfg.sshPassword);
        if (result.ok) {
          session.setup.wpPath = session.setup.wpPath || result.wpPath;
          saveSetup(session.setup);
          const wpCliStatus = result.wpCliFound
            ? '✅ WP-CLI is installed'
            : '⚠️ WP-CLI not found — I\'ll install it for you';
          const msg = buildAssistantMsg(`✅ SSH connected!\n\n${wpCliStatus}\n\nFound WordPress at: \`${result.wpPath}\`\n\nYou're almost ready! ${result.wpCliFound ? '[CHIP Start using WP Agent]' : '[CHIP Install WP-CLI for me]'}`);
          session.messages.push(msg);
          socket.emit('chat:message', msg);
        } else {
          const msg = buildAssistantMsg(`❌ ${result.error}\n\nDouble-check:\n- Is the hostname correct?\n- Is SSH enabled on your hosting?\n- Is the username and password right?\n\n[CHIP Try again] [CHIP I need help with SSH]`);
          session.messages.push(msg);
          socket.emit('chat:message', msg);
        }
      }

      if (action.type === 'setup_complete') {
        session.setup.setupComplete = true;
        saveSetup(session.setup);
        applySetupToEnv(session.setup);
        socket.emit('chat:setup_complete', { siteName: session.setup.siteName });
        // Send welcome message with quick actions
        const msg = buildAssistantMsg(
          `🎉 Setup complete! WP Agent is connected to **${session.setup.siteName || session.setup.wpUrl}** and ready to work.\n\nWhat would you like me to do first?`,
          {
            chips: ['Update all plugins', 'Run a site health check', 'Check for errors', 'Show me what needs attention'],
          }
        );
        session.messages.push(msg);
        socket.emit('chat:message', msg);
      }

      if (action.type === 'run_task') {
        await executeTask(action.value, socketId, session, socket, io);
      }
    }

  } catch (err) {
    socket.emit('chat:typing', false);
    socket.emit('chat:error', { message: `Something went wrong: ${err}` });
    bus.log('error', `Chat error for ${socketId}: ${err}`, 'orchestrator');
  }
}

// ─── Task execution with live streaming to chat ───────────────

async function executeTask(
  description: string,
  socketId: string,
  session: ChatSession,
  socket: ReturnType<SocketIO['sockets']['sockets']['get']>,
  io: SocketIO,
): Promise<void> {
  if (!socket) return;

  const taskId = uuidv4();

  // Tell user task is starting
  const startMsg = buildAssistantMsg(`Starting: **${description}**\n\nI'll keep you updated as I work through it…`, { taskId });
  session.messages.push(startMsg);
  socket.emit('chat:message', startMsg);

  // Attach bus listener to stream progress to this socket
  const onLog = (entry: { level: string; agent?: string; message: string }) => {
    socket.emit('chat:agent_log', {
      level: entry.level,
      agent: entry.agent,
      message: entry.message,
    });
  };

  const onEvent = (event: { type: string; data: unknown }) => {
    if (event.type === 'approval:requested') {
      const req = event.data as { id: string; action: string; risk: string; details: unknown };
      socket.emit('chat:approval_request', {
        id: req.id,
        action: req.action,
        risk: req.risk,
        details: req.details,
      });
    }
    if (event.type === 'step:completed') {
      socket.emit('chat:step_done', event.data);
    }
  };

  bus.on('log', onLog);
  bus.on('event', onEvent);

  try {
    applySetupToEnv(session.setup);
    const config = loadSiteConfig();
    const orchestrator = new Orchestrator(config);
    const task = await orchestrator.run(description);

    bus.off('log', onLog);
    bus.off('event', onEvent);

    // Summarise result in chat
    const succeeded = task.status === 'completed';
    const stepCount = task.steps.length;
    const toolCount = task.steps.reduce((n, s) => n + s.toolCalls.length, 0);

    const summary = succeeded
      ? `✅ Done! Completed **${description}**\n\n${task.result || ''}\n\n_${stepCount} steps, ${toolCount} operations_`
      : `❌ Task failed: **${task.error || 'Unknown error'}**\n\nI've rolled back any changes. Want me to try a different approach?`;

    const doneMsg = buildAssistantMsg(summary, {
      chips: succeeded
        ? ['Run site tests now', 'What else needs attention?', 'Show task details']
        : ['Try again', 'Debug the error', 'Get help'],
      taskId: task.id,
      type: succeeded ? 'success' : 'error',
    });
    session.messages.push(doneMsg);
    socket.emit('chat:message', doneMsg);

  } catch (err) {
    bus.off('log', onLog);
    bus.off('event', onEvent);
    const errMsg = buildAssistantMsg(`❌ Error running task: ${err}\n\n[CHIP Try again] [CHIP Get help]`);
    session.messages.push(errMsg);
    socket.emit('chat:message', errMsg);
  }
}

function buildAssistantMsg(content: string, meta: Record<string, unknown> = {}): ChatMessage {
  const parsed = parseResponse(content);
  return {
    id: uuidv4(),
    role: 'assistant',
    content: parsed.text,
    timestamp: new Date().toISOString(),
    type: (meta.type as ChatMessage['type']) || 'text',
    meta: {
      chips: [
        ...(meta.chips as string[] || []),
        ...parsed.actions.filter(a => a.type === 'chip').map(a => a.value),
      ],
      links: parsed.actions.filter(a => a.type === 'link').map(a => ({ label: a.value, url: a.extra })),
      taskId: meta.taskId,
    },
  };
}

// ─── Welcome message for new sessions ────────────────────────

export function getWelcomeMessage(isSetup: boolean, siteName?: string): ChatMessage {
  if (isSetup && siteName) {
    return buildAssistantMsg(
      `👋 Welcome back! I'm connected to **${siteName}**.\n\nWhat would you like me to do today?`,
      { chips: ['Update all plugins', 'Run health check', 'Check for errors', 'Full site audit'] }
    );
  }
  return buildAssistantMsg(
    `👋 Hi! I'm **WP Agent** — your AI WordPress maintenance assistant.\n\nI can update plugins, fix bugs, test your site, create pages, and handle everything your WordPress developer would do.\n\nTo get started, I just need to connect to your WordPress site. Ready?`,
    { chips: ['Yes, let\'s connect my site', 'What can you do?', 'How does this work?'] }
  );
}
