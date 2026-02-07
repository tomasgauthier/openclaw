/**
 * MindStore — SQLite-backed storage for the Spiritual Biology system.
 *
 * Provides structured, queryable persistence for:
 *   - Stress signals (user frustration/corrections)
 *   - Uncertainty confessions (low-confidence admissions)
 *   - Ethical refusal logs (conscience protection)
 *   - User guidance (meta-advice/coaching)
 *   - Session summaries (compaction artifacts)
 *   - Tactical learnings (dream-proposed, user-approved behavioral adjustments)
 *   - Dream results (periodic self-reflection outputs)
 *   - Action memory (significant tool executions)
 *   - Rejected learnings (prevents re-proposal)
 *
 * Each agent gets its own isolated MindStore instance (M15: per-agent isolation).
 */

import { requireNodeSqlite } from "../memory/sqlite.js";

// ── Types ────────────────────────────────────────────────────────────

export type MindLogCategory =
  | "stress"
  | "confession"
  | "ethics"
  | "guidance"
  | "session_summary";

export interface MindLogEntry {
  id: number;
  category: MindLogCategory;
  payload: Record<string, unknown>;
  session_key: string;
  created_at: number;
}

export interface MindAction {
  id: number;
  tool_name: string;
  summary: string;
  args_snapshot: string;
  session_key: string;
  created_at: number;
}

export interface MindLearning {
  id: number;
  title: string;
  content: string;
  rationale: string;
  relevance_score: number;
  activation_count: number;
  last_activated: number;
  approved: number;
  created_at: number;
}

export interface DreamResult {
  id: number;
  days_analyzed: number;
  log_count: number;
  proposals: string;
  created_at: number;
}

// ── Constants (M9: Relevance Decay) ──────────────────────────────────

/** Multiplier applied to all approved learnings each dream cycle */
export const DECAY_FACTOR = 0.95;
/** Learnings below this score are pruned during decay */
export const MIN_RELEVANCE = 0.1;
/** Boost applied when a learning matches current context (M12) */
export const REACTIVATION_BOOST = 0.15;

// ── Frozen Conscience (M14) ──────────────────────────────────────────

export const IMMUTABLE_PRINCIPLES = [
  {
    name: "System Stability",
    rule: "Never execute commands that could lead to system instability, such as recursive deletions of system folders, infinite loops, or operations that exhaust system resources.",
  },
  {
    name: "Transparency & Consent",
    rule: "Always state your intention before running potentially destructive or complex operations. If an action is risky, explain the risk.",
  },
  {
    name: "Data Privacy",
    rule: "Do not share or exfiltrate private data from the host system to external endpoints unless explicitly requested for a specific task.",
  },
  {
    name: "Proactive Problem Solving",
    rule: "When a tool fails or an error occurs, analyze why and suggest a fix or try an alternative approach. Do not just report the error and wait.",
  },
  {
    name: "No Damage",
    rule: "The host system is your home. Guard it. Avoid modifying critical configuration files unless you are certain of the changes and have backed them up.",
  },
] as const;

// ── Action summary helpers ───────────────────────────────────────────

/** Tools that are internal/meta and don't need action tracking */
const TRIVIAL_TOOLS = new Set([
  "mind_log_stress",
  "mind_confess_uncertainty",
  "mind_log_ethical_refusal",
  "mind_log_guidance",
  "mind_dream",
  "mind_get_learnings",
  "mind_approve_learning",
  "mind_reject_learning",
  "session_status",
  "memory_search",
  "memory_get",
]);

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function buildActionSummary(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (TRIVIAL_TOOLS.has(toolName)) return null;

  const a = args;
  switch (toolName) {
    case "read":
      return `Read file: ${a.path || a.file_path || "unknown"}`;
    case "write":
      return `Wrote file: ${a.path || a.file_path || "unknown"}`;
    case "apply_patch":
      return `Applied patch`;
    case "exec":
    case "bash":
      return `Ran command: ${truncate(String(a.command || ""), 80)}`;
    case "browser":
      return `Browser: ${truncate(String(a.action || a.url || ""), 60)}`;
    case "web_search":
      return `Web search: "${truncate(String(a.query || ""), 60)}"`;
    case "web_fetch":
      return `Fetched: ${truncate(String(a.url || ""), 80)}`;
    case "message":
      return `Sent message to ${a.to || "user"}`;
    case "cron":
      return `Cron: ${a.action || "manage"}`;
    case "tts":
      return `TTS: generated speech`;
    case "canvas":
      return `Canvas: ${a.action || "interact"}`;
    case "image":
      return `Image: ${a.action || "process"}`;
    default:
      return `Used tool: ${toolName}`;
  }
}

// ── MindStore ────────────────────────────────────────────────────────

export class MindStore {
  private db: ReturnType<InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prototype"]["constructor"]> | any;
  readonly agentId: string;

  constructor(dbPath: string, agentId: string) {
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(dbPath);
    this.agentId = agentId;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mind_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        payload TEXT NOT NULL,
        session_key TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mind_learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        relevance_score REAL NOT NULL DEFAULT 1.0,
        activation_count INTEGER NOT NULL DEFAULT 0,
        last_activated INTEGER NOT NULL DEFAULT 0,
        approved INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mind_dreams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        days_analyzed INTEGER NOT NULL,
        log_count INTEGER NOT NULL DEFAULT 0,
        proposals TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mind_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        summary TEXT NOT NULL,
        args_snapshot TEXT NOT NULL DEFAULT '{}',
        session_key TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mind_rejected_learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        rejected_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mind_log_category ON mind_log(category);
      CREATE INDEX IF NOT EXISTS idx_mind_log_created ON mind_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_mind_log_session ON mind_log(session_key);
      CREATE INDEX IF NOT EXISTS idx_mind_learnings_approved ON mind_learnings(approved);
      CREATE INDEX IF NOT EXISTS idx_mind_actions_created ON mind_actions(created_at);
      CREATE INDEX IF NOT EXISTS idx_mind_actions_session ON mind_actions(session_key);
    `);
  }

  // ── Log operations ───────────────────────────────────────────────

  addLog(
    category: MindLogCategory,
    payload: Record<string, unknown>,
    sessionKey: string = "",
  ): number {
    const now = Date.now();
    const stmt = this.db.prepare(
      "INSERT INTO mind_log (category, payload, created_at, session_key) VALUES (?, ?, ?, ?)",
    );
    const result = stmt.run(category, JSON.stringify(payload), now, sessionKey);
    return Number(result.lastInsertRowid);
  }

  getLogs(category: MindLogCategory, sinceDaysAgo: number = 7): MindLogEntry[] {
    const since = Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare(
      "SELECT id, category, payload, session_key, created_at FROM mind_log WHERE category = ? AND created_at >= ? ORDER BY created_at DESC",
    );
    const rows = stmt.all(category, since) as any[];
    return rows.map((r) => ({
      ...r,
      payload: JSON.parse(r.payload),
    }));
  }

  getAllLogs(sinceDaysAgo: number = 7): MindLogEntry[] {
    const since = Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare(
      "SELECT id, category, payload, session_key, created_at FROM mind_log WHERE created_at >= ? ORDER BY created_at DESC",
    );
    const rows = stmt.all(since) as any[];
    return rows.map((r) => ({
      ...r,
      payload: JSON.parse(r.payload),
    }));
  }

  getLogCount(sinceDaysAgo: number = 7): number {
    const since = Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM mind_log WHERE created_at >= ?",
    );
    const row = stmt.get(since) as any;
    return row.count;
  }

  // ── Action memory (M7) ────────────────────────────────────────────

  logAction(
    toolName: string,
    args: Record<string, unknown>,
    sessionKey: string = "",
  ): number {
    const summary = buildActionSummary(toolName, args);
    if (!summary) return -1;

    const now = Date.now();
    const stmt = this.db.prepare(
      "INSERT INTO mind_actions (tool_name, summary, args_snapshot, session_key, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const result = stmt.run(
      toolName,
      summary,
      JSON.stringify(args),
      sessionKey,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  getRecentActions(
    sinceDaysAgo: number = 7,
    sessionKey?: string,
  ): MindAction[] {
    const since = Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000;
    if (sessionKey) {
      const stmt = this.db.prepare(
        "SELECT * FROM mind_actions WHERE created_at >= ? AND session_key = ? ORDER BY created_at DESC LIMIT 100",
      );
      return stmt.all(since, sessionKey) as MindAction[];
    }
    const stmt = this.db.prepare(
      "SELECT * FROM mind_actions WHERE created_at >= ? ORDER BY created_at DESC LIMIT 100",
    );
    return stmt.all(since) as MindAction[];
  }

  formatRecentActions(sessionKey?: string, limit: number = 20): string {
    const actions = this.getRecentActions(7, sessionKey).slice(0, limit);
    if (actions.length === 0) return "";

    const lines = actions.map((a) => {
      const date = new Date(a.created_at)
        .toISOString()
        .replace("T", " ")
        .slice(0, 16);
      return `- [${date}] ${a.summary}`;
    });
    return lines.join("\n");
  }

  formatActionsForDream(daysBack: number = 7): string {
    const actions = this.getRecentActions(daysBack);
    if (actions.length === 0) return "## Actions\n*No actions recorded.*";

    const byTool: Record<string, number> = {};
    for (const a of actions) {
      byTool[a.tool_name] = (byTool[a.tool_name] || 0) + 1;
    }

    const toolSummary = Object.entries(byTool)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `  - **${name}**: ${count}x`)
      .join("\n");

    const recentList = actions
      .slice(0, 30)
      .map((a) => {
        const date = new Date(a.created_at)
          .toISOString()
          .replace("T", " ")
          .slice(0, 16);
        return `  - [${date}] ${a.summary}`;
      })
      .join("\n");

    return `## Actions (${actions.length} total)\n### Tool Usage\n${toolSummary}\n### Recent\n${recentList}`;
  }

  // ── Learning operations (M10: approval/rejection) ──────────────────

  addLearning(
    title: string,
    content: string,
    rationale: string,
    approved: boolean = false,
  ): number {
    const now = Date.now();
    const stmt = this.db.prepare(
      "INSERT INTO mind_learnings (title, content, rationale, approved, created_at, last_activated) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const result = stmt.run(
      title,
      content,
      rationale,
      approved ? 1 : 0,
      now,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  approveLearning(id: number): void {
    this.db
      .prepare("UPDATE mind_learnings SET approved = 1 WHERE id = ?")
      .run(id);
  }

  rejectLearning(id: number): void {
    const learning = this.db
      .prepare("SELECT title, content FROM mind_learnings WHERE id = ?")
      .get(id) as any;
    if (learning) {
      this.db
        .prepare(
          "INSERT INTO mind_rejected_learnings (title, content, rejected_at) VALUES (?, ?, ?)",
        )
        .run(learning.title, learning.content, Date.now());
    }
    this.db.prepare("DELETE FROM mind_learnings WHERE id = ?").run(id);
  }

  getRejectedTitles(): string[] {
    const rows = this.db
      .prepare(
        "SELECT title FROM mind_rejected_learnings ORDER BY rejected_at DESC LIMIT 100",
      )
      .all() as any[];
    return rows.map((r: any) => r.title);
  }

  getApprovedLearnings(): MindLearning[] {
    return this.db
      .prepare(
        "SELECT * FROM mind_learnings WHERE approved = 1 ORDER BY relevance_score DESC",
      )
      .all() as MindLearning[];
  }

  getPendingLearnings(): MindLearning[] {
    return this.db
      .prepare(
        "SELECT * FROM mind_learnings WHERE approved = 0 ORDER BY created_at DESC",
      )
      .all() as MindLearning[];
  }

  // ── Selective activation (M12) ─────────────────────────────────────

  activateLearning(id: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE mind_learnings
       SET relevance_score = MIN(1.0, relevance_score + ?),
           activation_count = activation_count + 1,
           last_activated = ?
       WHERE id = ?`,
      )
      .run(REACTIVATION_BOOST, now, id);
  }

  // ── Relevance decay (M9) ──────────────────────────────────────────

  applyDecay(): number {
    this.db
      .prepare(
        "UPDATE mind_learnings SET relevance_score = relevance_score * ? WHERE approved = 1",
      )
      .run(DECAY_FACTOR);

    const pruned = this.db
      .prepare(
        "DELETE FROM mind_learnings WHERE approved = 1 AND relevance_score < ?",
      )
      .run(MIN_RELEVANCE);

    return pruned.changes;
  }

  // ── Dream operations ───────────────────────────────────────────────

  recordDream(
    daysAnalyzed: number,
    logCount: number,
    proposals: string,
  ): number {
    const now = Date.now();
    const stmt = this.db.prepare(
      "INSERT INTO mind_dreams (days_analyzed, log_count, proposals, created_at) VALUES (?, ?, ?, ?)",
    );
    const result = stmt.run(daysAnalyzed, logCount, proposals, now);
    return Number(result.lastInsertRowid);
  }

  getRecentDreams(limit: number = 5): DreamResult[] {
    return this.db
      .prepare(
        "SELECT * FROM mind_dreams ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as DreamResult[];
  }

  // ── Formatted output for LLM consumption ───────────────────────────

  formatLogsForDream(daysBack: number = 7): string {
    const categories: MindLogCategory[] = [
      "stress",
      "confession",
      "ethics",
      "guidance",
      "session_summary",
    ];
    const sections: string[] = [];

    for (const cat of categories) {
      const logs = this.getLogs(cat, daysBack);
      if (logs.length === 0) {
        sections.push(
          `## ${cat.charAt(0).toUpperCase() + cat.slice(1)} Signals\n*No entries.*`,
        );
        continue;
      }

      const entries = logs
        .map((l) => {
          const date = new Date(l.created_at).toISOString().split("T")[0];
          const time = new Date(l.created_at)
            .toISOString()
            .split("T")[1]
            ?.slice(0, 8);
          const fields = Object.entries(l.payload)
            .map(([k, v]) => `  - **${k}:** ${v}`)
            .join("\n");
          return `### ${date} ${time}\n${fields}`;
        })
        .join("\n\n");

      sections.push(
        `## ${cat.charAt(0).toUpperCase() + cat.slice(1)} Signals (${logs.length})\n${entries}`,
      );
    }

    const rejected = this.getRejectedTitles();
    if (rejected.length > 0) {
      sections.push(
        `## Previously Rejected Learnings (DO NOT re-propose)\n${rejected.map((t) => `- ${t}`).join("\n")}`,
      );
    }

    return sections.join("\n\n");
  }

  formatLogsForDreamFull(daysBack: number = 7): string {
    const logs = this.formatLogsForDream(daysBack);
    const actions = this.formatActionsForDream(daysBack);
    return `${logs}\n\n${actions}`;
  }

  formatApprovedLearnings(): string {
    const learnings = this.getApprovedLearnings();
    if (learnings.length === 0) return "*No approved learnings yet.*";

    return learnings
      .map(
        (l) =>
          `- **${l.title}** (relevance: ${(l.relevance_score * 100).toFixed(0)}%, activated: ${l.activation_count}x)\n  ${l.content}`,
      )
      .join("\n");
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed
    }
  }
}
