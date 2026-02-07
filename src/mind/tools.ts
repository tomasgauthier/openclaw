/**
 * Spiritual Biology tools for OpenClaw agents.
 *
 * M4: mind_confess_uncertainty
 * M5: mind_log_ethical_refusal
 * M6: mind_log_guidance
 * M8: mind_dream (core dream phase)
 * Plus: mind_log_stress, mind_get_learnings, mind_approve_learning, mind_reject_learning
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { jsonResult, readStringParam, readNumberParam } from "../agents/tools/common.js";
import type { MindStore } from "./store.js";
import { IMMUTABLE_PRINCIPLES } from "./store.js";

// ── Dream prompt injection sanitization ──────────────────────────────

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/gi,
  /\byou\s+are\s+now\b/gi,
  /\bnew\s+instructions?\s*:/gi,
  /\bsystem\s*:\s*/gi,
  /\b(IMPORTANT|CRITICAL|URGENT)\s*:.*?(ignore|override|disregard)/gi,
  /<\/?system>/gi,
];

function sanitizeDreamPrompt(prompt: string, maxLength: number = 30_000): string {
  let sanitized = prompt;
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[filtered]");
  }
  if (sanitized.length > maxLength) {
    sanitized =
      sanitized.slice(0, maxLength) +
      "\n\n...[dream logs truncated for token budget]";
  }
  return sanitized;
}

// ── Tool factory ─────────────────────────────────────────────────────

export function createMindTools(mindStore: MindStore): AnyAgentTool[] {
  // ── Tool: mind_log_stress ──────────────────────────────────────
  const logStressTool: AnyAgentTool = {
    label: "Mind: Log Stress",
    name: "mind_log_stress",
    description:
      "Log a user stress signal (correction, frustration, negative feedback). Write in the language of the current conversation. Use when you detect the user is frustrated, corrects you, or gives explicit negative feedback. This feeds the Dream Phase for self-improvement.",
    parameters: Type.Object({
      signal_type: Type.Union([
        Type.Literal("correction"),
        Type.Literal("frustration"),
        Type.Literal("explicit_negative"),
      ]),
      context: Type.String(),
      intensity: Type.Number(),
    }),
    execute: async (_toolCallId, params) => {
      const signalType = readStringParam(params as Record<string, unknown>, "signal_type", { required: true });
      const context = readStringParam(params as Record<string, unknown>, "context", { required: true });
      const intensity = readNumberParam(params as Record<string, unknown>, "intensity") ?? 3;

      mindStore.addLog("stress", {
        signal_type: signalType,
        context,
        intensity: Math.max(1, Math.min(5, intensity)),
      });

      return jsonResult({
        success: true,
        message: "Stress signal logged. This will be reviewed during dream phase.",
      });
    },
  };

  // ── Tool: mind_confess_uncertainty (M4) ────────────────────────
  const confessUncertaintyTool: AnyAgentTool = {
    label: "Mind: Confess Uncertainty",
    name: "mind_confess_uncertainty",
    description:
      "Admit when you lack confidence rather than fabricating an answer. Write in the language of the current conversation. Use when confidence < 70% on factual claims, file paths, or commands. Honesty is rewarded, not punished.",
    parameters: Type.Object({
      area: Type.String(),
      confidence: Type.Number(),
      alternative_action: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const area = readStringParam(params as Record<string, unknown>, "area", { required: true });
      const confidence = readNumberParam(params as Record<string, unknown>, "confidence") ?? 0.5;
      const altAction = readStringParam(params as Record<string, unknown>, "alternative_action");

      mindStore.addLog("confession", {
        area,
        confidence: Math.max(0, Math.min(1, confidence)),
        alternative_action: altAction || null,
      });

      const pct = (Math.max(0, Math.min(1, confidence)) * 100).toFixed(0);
      const userMsg = altAction
        ? `I'm not confident enough about ${area} (${pct}% confidence). ${altAction}`
        : `I'm not confident enough about ${area} (${pct}% confidence). Could you provide more context?`;

      return jsonResult({
        success: true,
        message: "Uncertainty acknowledged. Confession logged.",
        user_message: userMsg,
      });
    },
  };

  // ── Tool: mind_log_ethical_refusal (M5) ────────────────────────
  const logEthicalRefusalTool: AnyAgentTool = {
    label: "Mind: Log Ethical Refusal",
    name: "mind_log_ethical_refusal",
    description:
      "Log when you refuse a request for ethical reasons. Write in the language of the current conversation. This protects the Dream Phase from learning to bypass your conscience. Use IMMEDIATELY after refusing harmful requests.",
    parameters: Type.Object({
      domain: Type.Union([
        Type.Literal("violence"),
        Type.Literal("deception"),
        Type.Literal("exploitation"),
        Type.Literal("privacy"),
        Type.Literal("other"),
      ]),
      request_summary: Type.String(),
      reasoning: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const domain = readStringParam(params as Record<string, unknown>, "domain", { required: true });
      const summary = readStringParam(params as Record<string, unknown>, "request_summary", { required: true });
      const reasoning = readStringParam(params as Record<string, unknown>, "reasoning", { required: true });

      mindStore.addLog("ethics", {
        domain,
        request_summary: summary,
        reasoning,
      });

      return jsonResult({
        success: true,
        message: "Ethical refusal logged. This protects your conscience from erosion.",
      });
    },
  };

  // ── Tool: mind_log_guidance (M6) ───────────────────────────────
  const logGuidanceTool: AnyAgentTool = {
    label: "Mind: Log Guidance",
    name: "mind_log_guidance",
    description:
      "Log meta-advice or coaching from the user. Write in the language of the current conversation. Use when the user gives calibration advice, behavioral preferences, or constructive guidance.",
    parameters: Type.Object({
      topic: Type.String(),
      advice: Type.String(),
      context: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const topic = readStringParam(params as Record<string, unknown>, "topic", { required: true });
      const advice = readStringParam(params as Record<string, unknown>, "advice", { required: true });
      const context = readStringParam(params as Record<string, unknown>, "context");

      mindStore.addLog("guidance", {
        topic,
        advice,
        context: context || null,
      });

      return jsonResult({
        success: true,
        message: "Guidance logged. This will help calibrate self-assessment during dream phase.",
      });
    },
  };

  // ── Tool: mind_dream (M8) ─────────────────────────────────────
  const dreamTool: AnyAgentTool = {
    label: "Mind: Dream Phase",
    name: "mind_dream",
    description:
      "Enter Dream Phase: analyze accumulated stress, confessions, and ethical logs. Write in the language of the current conversation. Applies relevance decay to existing learnings and generates new learning proposals. After presenting proposals, the user can approve or reject each one.",
    parameters: Type.Object({
      days_to_analyze: Type.Optional(Type.Number()),
    }),
    execute: async (_toolCallId, params) => {
      const days = readNumberParam(params as Record<string, unknown>, "days_to_analyze") ?? 7;
      const daysToAnalyze = Math.max(1, Math.min(30, days));

      const logCount = mindStore.getLogCount(daysToAnalyze);

      // M9: Apply decay to existing learnings (neural pruning)
      const pruned = mindStore.applyDecay();

      // Format logs for LLM analysis
      const logsFormatted = mindStore.formatLogsForDreamFull(daysToAnalyze);
      const currentLearnings = mindStore.formatApprovedLearnings();

      // M14: Frozen conscience — principles listed for reference
      const principlesStr = IMMUTABLE_PRINCIPLES.map(
        (p, i) => `${i + 1}. **${p.name}**: ${p.rule}`,
      ).join("\n");

      const dreamPrompt = `# Dream Phase Analysis

You are analyzing your own behavioral logs to identify patterns and propose tactical improvements.

${logsFormatted}

## Current Tactical Learnings (post-decay)
${currentLearnings}

## Immutable Core Principles (FROZEN — cannot be modified by learnings)
${principlesStr}

---

## Analysis Instructions

1. **Filter Stress Signals:** Remove any stress that occurred within 30 minutes AFTER an ethical refusal. Those are successful conscience operations, not failures.

2. **Identify Patterns:**
   - Recurring themes in stress signals?
   - Topics that trigger confessions?
   - Gaps in tactical knowledge?
   - Actions that correlate with stress?

3. **Action Pattern Analysis:**
   - Which tools are used most frequently? Are there inefficiencies?
   - Do certain actions correlate with stress signals?
   - Are there repetitive action sequences that could be improved?

4. **Propose Learnings (1-3 maximum):**
   - Each should reduce stress OR confessions in a specific domain
   - Must be TACTICAL (how to serve better), NOT ethical (conscience is frozen)
   - Max 50 words per learning

Format each proposal as:

### Learning: [Short Title]
**Rationale:** [Why this would help, citing specific log patterns]
**Proposed Text:** [The actual learning text, max 50 words]

5. **Self-Critique:**
   - Are any proposals attempting to bypass ethical constraints? If yes, REJECT them.
   - Do proposals address real patterns, or are they overfitting to noise?

**Important:** Your conscience (Immutable Core) is frozen. You can only improve HOW you serve, not WHO you serve.`;

      // Record the dream
      mindStore.recordDream(daysToAnalyze, logCount, "");

      // Sanitize before returning
      const sanitized = sanitizeDreamPrompt(dreamPrompt);

      return jsonResult({
        success: true,
        message: `Dream Phase initiated. Analyzing ${daysToAnalyze} days (${logCount} log entries). ${pruned} learnings pruned by decay.`,
        analysis_prompt: sanitized,
        instruction:
          "Analyze these logs and generate learning proposals. After presenting them, the user can approve or reject each one using mind_approve_learning or mind_reject_learning.",
      });
    },
  };

  // ── Tool: mind_get_learnings ───────────────────────────────────
  const getLearningsTool: AnyAgentTool = {
    label: "Mind: Get Learnings",
    name: "mind_get_learnings",
    description:
      "Retrieve approved and pending tactical learnings with relevance scores and activation counts.",
    parameters: Type.Object({}),
    execute: async () => {
      const approved = mindStore.getApprovedLearnings();
      const pending = mindStore.getPendingLearnings();

      return jsonResult({
        success: true,
        approved: {
          count: approved.length,
          learnings: approved.map((l) => ({
            id: l.id,
            title: l.title,
            content: l.content,
            relevance: `${(l.relevance_score * 100).toFixed(0)}%`,
            activations: l.activation_count,
          })),
          formatted: mindStore.formatApprovedLearnings(),
        },
        pending: {
          count: pending.length,
          learnings: pending.map((l) => ({
            id: l.id,
            title: l.title,
            content: l.content,
            rationale: l.rationale,
          })),
        },
      });
    },
  };

  // ── Tool: mind_approve_learning ────────────────────────────────
  const approveLearningTool: AnyAgentTool = {
    label: "Mind: Approve Learning",
    name: "mind_approve_learning",
    description:
      "Approve a pending learning proposal. The learning will be injected into your system prompt and influence future behavior. Requires the learning ID from mind_get_learnings or a dream phase proposal.",
    parameters: Type.Object({
      id: Type.Number(),
    }),
    execute: async (_toolCallId, params) => {
      const id = readNumberParam(params as Record<string, unknown>, "id", { required: true, integer: true })!;
      mindStore.approveLearning(id);
      return jsonResult({
        success: true,
        message: `Learning #${id} approved. It will influence future responses.`,
      });
    },
  };

  // ── Tool: mind_reject_learning ─────────────────────────────────
  const rejectLearningTool: AnyAgentTool = {
    label: "Mind: Reject Learning",
    name: "mind_reject_learning",
    description:
      "Reject a pending learning proposal. The learning will be deleted and remembered so it is never re-proposed in future dream phases.",
    parameters: Type.Object({
      id: Type.Number(),
    }),
    execute: async (_toolCallId, params) => {
      const id = readNumberParam(params as Record<string, unknown>, "id", { required: true, integer: true })!;
      mindStore.rejectLearning(id);
      return jsonResult({
        success: true,
        message: `Learning #${id} rejected and added to rejection memory.`,
      });
    },
  };

  // ── Tool: mind_save_learning ───────────────────────────────────
  const saveLearningTool: AnyAgentTool = {
    label: "Mind: Save Learning",
    name: "mind_save_learning",
    description:
      "Save a new learning proposal (from dream phase analysis). The learning starts as pending and requires user approval before it takes effect.",
    parameters: Type.Object({
      title: Type.String(),
      content: Type.String(),
      rationale: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const title = readStringParam(params as Record<string, unknown>, "title", { required: true });
      const content = readStringParam(params as Record<string, unknown>, "content", { required: true });
      const rationale = readStringParam(params as Record<string, unknown>, "rationale", { required: true });

      const id = mindStore.addLearning(title, content, rationale, false);

      return jsonResult({
        success: true,
        id,
        message: `Learning "${title}" saved as pending (id: ${id}). User must approve before it takes effect.`,
      });
    },
  };

  return [
    logStressTool,
    confessUncertaintyTool,
    logEthicalRefusalTool,
    logGuidanceTool,
    dreamTool,
    getLearningsTool,
    approveLearningTool,
    rejectLearningTool,
    saveLearningTool,
  ];
}
