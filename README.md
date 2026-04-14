# WP Agent — Agentic WordPress Maintenance System

A fully autonomous AI system that acts as a WordPress maintenance developer. Powered by Claude, it can design pages, fix bugs, update plugins, test your site as a real user, and handle any WordPress task end-to-end.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Orchestrator Agent                     │
│  Plans tasks, delegates to sub-agents, manages safety    │
└───────────┬────────────┬─────────────┬──────────────────┘
            │            │             │            │
       ┌────▼──┐  ┌──────▼─┐  ┌───────▼┐  ┌───────▼──┐
       │Builder│  │Updater │  │Debugger│  │ Tester   │
       │ pages │  │plugins │  │ logs   │  │ browser  │
       │ themes│  │ core   │  │ fixes  │  │ UX tests │
       └───┬───┘  └───┬────┘  └───┬────┘  └───┬──────┘
           │          │           │            │
     ┌─────▼──────────▼───────────▼────────────▼─────┐
     │            Tool Layer                           │
     │  WP-CLI · SSH Filesystem · WP REST · Playwright│
     └─────────────────────────┬───────────────────────┘
                                │
                     ┌──────────▼──────────┐
                     │    WordPress Site    │
                     └─────────────────────┘
```

### Agents

| Agent | Responsibility | Primary Tools |
|---|---|---|
| **Orchestrator** | Plans tasks, routes to agents, manages backup/rollback | Planning |
| **Builder** | Pages, themes, PHP/CSS/JS development | WP-CLI, SSH filesystem |
| **Updater** | Plugins, themes, WP core updates | WP-CLI |
| **Debugger** | Error logs, bug diagnosis, code fixes | WP-CLI, SSH filesystem |
| **Tester** | Browser-based UX testing, link checks, screenshots | Playwright |

---

## Setup

### Prerequisites

- Node.js 20+
- SSH access to your WordPress server
- WP-CLI installed on the server
- WordPress Application Password (Users → Profile → Application Passwords)

### Install

```bash
git clone <this-repo>
cd wp-agent
npm install
npx playwright install chromium
```

### Configure

```bash
cp .env.example .env
# Edit .env with your site credentials
```

Required environment variables:
- `ANTHROPIC_API_KEY` — get from console.anthropic.com
- `WP_URL` — your site URL
- `WP_USER` + `WP_APP_PASSWORD` — WordPress credentials
- `SSH_HOST`, `SSH_USER`, `SSH_KEY_PATH`, `WP_PATH` — server access

---

## Usage

### CLI

```bash
# Run any task in natural language
npm run dev -- run "Fix the checkout page that shows a 500 error"
npm run dev -- run "Add a cookie consent banner to the site"
npm run dev -- run "Optimise images in the /uploads folder"

# Quick commands
npm run dev -- update    # Update all plugins + themes + core
npm run dev -- test      # Full browser-based site test
npm run dev -- debug     # Read logs and fix errors
npm run dev -- scan      # Scan site and update memory

# Task management
npm run dev -- history   # Show recent tasks
npm run dev -- task <id> # Show task details
npm run dev -- approvals # Review pending approvals (interactive)

# Start web dashboard
npm run dev -- server
```

### Dashboard

```bash
npm run dev -- server
# Open http://localhost:3000
```

The dashboard provides:
- Real-time task log streaming
- Step-by-step execution view with tool call details
- One-click approval/denial for high-risk actions
- Quick action buttons for common tasks

---

## Safety System

### Risk Classification

| Level | Actions | Behaviour |
|---|---|---|
| `low` | Reads, cache flushes, content updates | Auto-approved |
| `medium` | Plugin installs, file writes, DB queries | Auto-approved |
| `high` | Core updates, deletes, `functions.php` edits | Requires human approval |
| `critical` | `DROP TABLE`, mass deletes | Requires human approval |

### Backup & Rollback

Before any risky task, the system:
1. Dumps the WordPress database to `/tmp/wp-backup-<id>.sql` on the server
2. Records the current git commit hash

If a step fails on a non-trivial task, it automatically rolls back to the snapshot.

### Staging First

When `STAGING_URL` and `STAGING_SSH_HOST` are set, all changes are applied to staging first. The tester agent verifies staging before the orchestrator promotes to production.

---

## Adding Custom Capabilities

### New tool

Add to `src/tools/wpcli.ts`:
```typescript
async myCustomTool(args: string): Promise<string> {
  return this.wp(`my-command ${args}`);
}
```

Then add to `wpCliToolDefinitions` array and `dispatchWpCliTool` switch.

### New agent

```typescript
export class SEOAgent extends WpCliAgent {
  name: AgentName = 'builder'; // reuse existing type or extend the union
  systemPrompt = `You are an SEO specialist agent...`;
  toolDefinitions = wpCliToolDefinitions;
}
```

Add to the orchestrator's `executeStep` switch.

---

## Data

All data is stored locally in `./data/`:
- `wp-agent.db` — SQLite database (tasks, approvals, site memory)
- `backups/` — database dump files
- `screenshots/` — browser test screenshots

---

## Limitations & Notes

1. **WP-CLI must be installed on the server.** Run `wp --info` to verify.
2. **Git is optional** but strongly recommended for rollbacks.
3. **Staging environment** is optional but strongly recommended for production sites.
4. **The agent may make mistakes** — always review high-risk operations before approving them in the approval gate.
5. **API costs** — complex tasks can use 20–50 Claude API calls. Monitor usage at console.anthropic.com.

---

## License

MIT
