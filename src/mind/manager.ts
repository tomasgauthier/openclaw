/**
 * MindManager — singleton factory for per-agent MindStore instances.
 *
 * M13: Dream cron scheduling
 * M15: Per-agent mind isolation
 * M16: Dashboard API helpers
 */

import path from "node:path";
import fs from "node:fs";
import { MindStore } from "./store.js";

// ── Per-agent store cache ────────────────────────────────────────────

const stores = new Map<string, MindStore>();

/**
 * Get or create a MindStore for the given agent.
 * Each agent gets its own SQLite database file.
 */
export function getMindStore(params: {
  agentId: string;
  dataDir: string;
}): MindStore {
  const { agentId, dataDir } = params;
  const normalizedId = agentId.trim().toLowerCase() || "main";

  const existing = stores.get(normalizedId);
  if (existing) return existing;

  const mindDir = path.join(dataDir, "mind");
  if (!fs.existsSync(mindDir)) {
    fs.mkdirSync(mindDir, { recursive: true });
  }

  const dbPath = path.join(mindDir, `${normalizedId}.db`);
  const store = new MindStore(dbPath, normalizedId);
  stores.set(normalizedId, store);
  return store;
}

/**
 * Check if a MindStore exists for the given agent (without creating one).
 */
export function hasMindStore(agentId: string): boolean {
  return stores.has(agentId.trim().toLowerCase() || "main");
}

/**
 * Get all active MindStore instances.
 */
export function getAllMindStores(): Map<string, MindStore> {
  return stores;
}

/**
 * Close all MindStore instances (for graceful shutdown).
 */
export function closeAllMindStores(): void {
  for (const [key, store] of stores) {
    store.close();
    stores.delete(key);
  }
}

// ── M13: Dream scheduling helpers ────────────────────────────────────

/**
 * Build a CronJob-compatible payload for dream scheduling.
 * Can be used with openclaw's CronService.add().
 */
export function buildDreamCronPayload(agentId: string): {
  id: string;
  name: string;
  agentId: string;
  schedule: { kind: "cron"; expression: string };
  sessionTarget: "isolated";
  wakeMode: "next-heartbeat";
  payload: {
    kind: "agentTurn";
    message: string;
    timeoutSeconds: number;
  };
} {
  return {
    id: `mind-dream-${agentId}`,
    name: `Dream Phase (${agentId})`,
    agentId,
    schedule: {
      kind: "cron",
      expression: process.env.OPENCLAW_DREAM_CRON || "0 3 * * *",
    },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message:
        "[DREAM_PHASE] Analyze recent stress patterns, confessions, and action logs. Use mind_dream to enter the Dream Phase and propose tactical learnings.",
      timeoutSeconds: 120,
    },
  };
}

// ── M16: Dashboard API helpers ───────────────────────────────────────

export interface MindDashboardData {
  agentId: string;
  learnings: {
    approved: ReturnType<MindStore["getApprovedLearnings"]>;
    pending: ReturnType<MindStore["getPendingLearnings"]>;
  };
  recentDreams: ReturnType<MindStore["getRecentDreams"]>;
  stressLogs: ReturnType<MindStore["getLogs"]>;
  confessionLogs: ReturnType<MindStore["getLogs"]>;
  ethicsLogs: ReturnType<MindStore["getLogs"]>;
  guidanceLogs: ReturnType<MindStore["getLogs"]>;
  logCount: number;
  rejectedTitles: string[];
}

/**
 * Get dashboard data for a specific agent's mind store.
 */
export function getMindDashboardData(
  store: MindStore,
  daysBack: number = 7,
): MindDashboardData {
  return {
    agentId: store.agentId,
    learnings: {
      approved: store.getApprovedLearnings(),
      pending: store.getPendingLearnings(),
    },
    recentDreams: store.getRecentDreams(5),
    stressLogs: store.getLogs("stress", daysBack),
    confessionLogs: store.getLogs("confession", daysBack),
    ethicsLogs: store.getLogs("ethics", daysBack),
    guidanceLogs: store.getLogs("guidance", daysBack),
    logCount: store.getLogCount(daysBack),
    rejectedTitles: store.getRejectedTitles(),
  };
}
