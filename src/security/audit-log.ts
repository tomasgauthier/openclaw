/**
 * Runtime audit event log.
 *
 * Records security-relevant events (shell executions, auth failures, config
 * changes, cost ceiling hits) to a SQLite database for forensic analysis.
 *
 * This is separate from audit.ts which is the static security scanner.
 */

import path from "node:path";
import fs from "node:fs";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { redactSensitiveText } from "../logging/redact.js";

export type AuditAction =
  | "shell_execute"
  | "config_update"
  | "file_write"
  | "file_delete"
  | "auth_failure"
  | "hook_auth_failure"
  | "rate_limited"
  | "privileged_tool"
  | "cost_ceiling_hit";

export interface AuditEntry {
  id: number;
  action: string;
  detail: string;
  sessionKey: string | null;
  ip: string | null;
  createdAt: number;
}

export class AuditLog {
  // oxlint-disable-next-line typescript/no-explicit-any
  private db: any;

  constructor(dbPath: string) {
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        session_key TEXT,
        ip TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action);
      CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at);
    `);
  }

  log(action: AuditAction, detail: string, opts?: { sessionKey?: string; ip?: string }): void {
    try {
      // S10: Redact sensitive data (API keys, tokens) from audit log details
      const safeDetail = redactSensitiveText(detail);
      this.db
        .prepare(
          "INSERT INTO audit_events (action, detail, session_key, ip, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(action, safeDetail, opts?.sessionKey ?? null, opts?.ip ?? null, Date.now());
    } catch {
      // Never block the main flow
    }
  }

  getRecent(limit: number = 50): AuditEntry[] {
    return this.db
      .prepare(
        "SELECT id, action, detail, session_key as sessionKey, ip, created_at as createdAt FROM audit_events ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit);
  }

  getByAction(action: AuditAction, limit: number = 50): AuditEntry[] {
    return this.db
      .prepare(
        "SELECT id, action, detail, session_key as sessionKey, ip, created_at as createdAt FROM audit_events WHERE action = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(action, limit);
  }

  getDailySummary(): Record<string, number> {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const rows: Array<{ action: string; count: number }> = this.db
      .prepare(
        "SELECT action, COUNT(*) as count FROM audit_events WHERE created_at >= ? GROUP BY action",
      )
      .all(dayStart.getTime());
    const summary: Record<string, number> = {};
    for (const row of rows) {
      summary[row.action] = row.count;
    }
    return summary;
  }

  /** Prune entries older than retentionDays (default 90). */
  prune(retentionDays: number = 90): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const result = this.db.prepare("DELETE FROM audit_events WHERE created_at < ?").run(cutoff);
    return result.changes ?? 0;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────

let instance: AuditLog | null = null;

/**
 * Get or create the singleton AuditLog instance.
 * @param dataDir - State directory (e.g. from resolveStateDir()). Required on first call.
 */
export function getAuditLog(dataDir?: string): AuditLog | null {
  if (instance) {
    return instance;
  }
  if (!dataDir) {
    return null;
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    instance = new AuditLog(path.join(dataDir, "audit.db"));
    return instance;
  } catch {
    return null;
  }
}
