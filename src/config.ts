// src/config.ts
import dotenv from "dotenv";
import { EventEmitter } from "events";
import {
  SiteConfig,
  DashboardEvent,
  LogEntry,
  LogLevel,
  AgentName,
} from "./types";

dotenv.config();

export function loadSiteConfig(): SiteConfig {
  return {
    url: process.env.WP_URL?.replace(/\/$/, "") || "",
    wpUser: process.env.WP_USER || "",
    wpAppPassword: process.env.WP_APP_PASSWORD || "",
    sshHost: process.env.SSH_HOST || "",
    sshPort: parseInt(process.env.SSH_PORT || "22"),
    sshUser: process.env.SSH_USER || "",
    sshKeyPath: process.env.SSH_KEY_PATH || "",
    wpPath: process.env.WP_PATH?.replace(/\/$/, "") || "",
    stagingUrl: process.env.STAGING_URL?.replace(/\/$/, ""),
    stagingSshHost: process.env.STAGING_SSH_HOST,
    stagingWpPath: process.env.STAGING_WP_PATH?.replace(/\/$/, ""),
    dbHost: process.env.DB_HOST || "localhost",
    dbName: process.env.DB_NAME || "",
    dbUser: process.env.DB_USER || "",
    dbPassword: process.env.DB_PASSWORD || "",
    gitRepo: process.env.GIT_REPO,
    gitBranch: process.env.GIT_BRANCH || "main",
  };
}

export const ANTHROPIC_API_KEY = require_env("ANTHROPIC_API_KEY");
export const REQUIRE_APPROVAL = process.env.REQUIRE_APPROVAL !== "false";
export const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || "3000");
export const MODEL = "claude-sonnet-4-20250514";
export const MAX_TOKENS = 4096;
export const MAX_AGENT_ITERATIONS = 30;

// ─── Global event bus (task log + dashboard streaming) ────────

class AgentEventBus extends EventEmitter {
  emit_event(event: DashboardEvent): boolean {
    return this.emit("event", event);
  }

  log(level: LogLevel, message: string, agent?: AgentName): void {
    const entry: LogEntry = {
      level,
      agent,
      message,
      timestamp: new Date().toISOString(),
    };
    this.emit("log", entry);
    this.emit_event({
      type: "log",
      data: entry,
      timestamp: entry.timestamp,
    });

    // Also print to console with colour
    const colors: Record<LogLevel, string> = {
      info: "\x1b[36m",
      warn: "\x1b[33m",
      error: "\x1b[31m",
      debug: "\x1b[90m",
      success: "\x1b[32m",
    };
    const reset = "\x1b[0m";
    const prefix = agent ? `[${agent.toUpperCase()}]` : "[SYSTEM]";
    console.log(`${colors[level]}${prefix} ${message}${reset}`);
  }
}

export const bus = new AgentEventBus();
