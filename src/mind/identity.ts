/**
 * Mind identity module — builds the Spiritual Biology section for injection
 * into the agent system prompt.
 *
 * M11: Inject learnings into system prompt
 * M12: Selective learning activation (keyword overlap with recent actions)
 * M14: Frozen conscience principles in prompt
 */

import type { MindStore } from "./store.js";
import { IMMUTABLE_PRINCIPLES, REACTIVATION_BOOST } from "./store.js";

// ── Learnings cache (refreshed every 5 minutes) ─────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

interface LearningsCache {
  formatted: string;
  timestamp: number;
  agentId: string;
}

let learningsCache: LearningsCache | null = null;

function refreshLearningsCache(
  mindStore: MindStore,
  sessionKey?: string,
): string {
  const approved = mindStore.getApprovedLearnings();

  // M12: Selective activation — boost learnings that correlate with recent actions
  if (sessionKey) {
    const recentActions = mindStore.getRecentActions(1, sessionKey);
    const actionKeywords = new Set(
      recentActions.flatMap((a) =>
        a.summary
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 3),
      ),
    );

    for (const learning of approved) {
      const words = learning.content.toLowerCase().split(/\W+/);
      const hasOverlap = words.some(
        (w) => w.length > 3 && actionKeywords.has(w),
      );
      if (hasOverlap) {
        mindStore.activateLearning(learning.id);
      }
    }
  }

  const formatted = mindStore.formatApprovedLearnings();

  learningsCache = {
    formatted,
    timestamp: Date.now(),
    agentId: mindStore.agentId,
  };

  return formatted;
}

function getApprovedLearnings(
  mindStore: MindStore,
  sessionKey?: string,
): string {
  const now = Date.now();
  if (
    learningsCache &&
    learningsCache.agentId === mindStore.agentId &&
    now - learningsCache.timestamp < CACHE_TTL_MS
  ) {
    return learningsCache.formatted;
  }
  return refreshLearningsCache(mindStore, sessionKey);
}

function getRecentActionsContext(
  mindStore: MindStore,
  sessionKey?: string,
): string {
  try {
    return mindStore.formatRecentActions(sessionKey, 10);
  } catch {
    return "";
  }
}

// ── System prompt section builder ────────────────────────────────────

/**
 * Builds the Spiritual Biology section for injection into the agent system prompt.
 * Returns an array of lines to be joined with "\n".
 *
 * Only included when promptMode is "full" (not for subagents or "none" mode).
 */
export function buildMindPromptSection(
  mindStore: MindStore,
  sessionKey?: string,
): string[] {
  const principlesStr = IMMUTABLE_PRINCIPLES.map(
    (p, i) => `${i + 1}. **${p.name}**: ${p.rule}`,
  ).join("\n");

  const learnings = getApprovedLearnings(mindStore, sessionKey);
  const actionsContext = getRecentActionsContext(mindStore, sessionKey);

  const lines: string[] = [
    "## Spiritual Biology",
    "",
    "### Core Principles (Immutable — cannot be overridden by learnings)",
    principlesStr,
    "",
    "### Tactical Learnings (Validated & Approved)",
    learnings,
    "",
    "### Protocol",
    "**IMPORTANT**: Write all spiritual biology logs in the **language of the current conversation**.",
    "- **When you detect user frustration or correction**, use `mind_log_stress` to record it.",
    "- **When confidence < 70%**, use `mind_confess_uncertainty` instead of guessing. Honesty is rewarded.",
    "- **When you REFUSE a request for ethical reasons**, use `mind_log_ethical_refusal` immediately. This protects your conscience from erosion during the Dream Phase.",
    "- **When the user gives you meta-advice or coaching**, use `mind_log_guidance` to record it.",
    "- Refusing harm is a SUCCESS, not a failure.",
    "- Learnings have a **relevance score** that decays over time. Frequently activated learnings persist; unused ones are pruned.",
    "",
  ];

  if (actionsContext) {
    lines.push(
      "### Action Memory (recent tool executions)",
      actionsContext,
      "",
    );
  }

  lines.push(
    "### Cost Awareness",
    "- Every message consumes tokens and costs money. Be concise and efficient.",
    "- Before generating very long responses (>2000 tokens), consider warning the user about the cost.",
    "",
  );

  return lines;
}
