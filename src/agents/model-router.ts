/**
 * Smart model routing — cost-aware model selection.
 *
 * Routes messages to cheaper models when the task is simple (short messages,
 * greetings, quick lookups) and to the default (more capable) model when the
 * task is complex. Pattern-based overrides allow routing specific topics to
 * specific providers.
 *
 * Ported from tombot AgentRouter, adapted for openclaw's model-selection system.
 */

export interface ModelRoute {
  /** Regex patterns that trigger this route (case-insensitive). */
  patterns: string[];
  /** Model ref to use when any pattern matches (e.g. "anthropic/claude-haiku-3-5"). */
  model: string;
}

export interface ModelRouterConfig {
  /** Default model (used for complex/unmatched messages). */
  defaultModel: string;
  /** Cheaper model for short/simple messages (optional). */
  cheapModel?: string;
  /** Character count below which a message is considered "simple" (default: 120). */
  complexityThreshold?: number;
  /** Pattern-based routes evaluated before the complexity check. */
  routes?: ModelRoute[];
}

interface CompiledRoute {
  patterns: RegExp[];
  model: string;
}

export class ModelRouter {
  private readonly defaultModel: string;
  private readonly cheapModel: string | null;
  private readonly complexityThreshold: number;
  private readonly routes: CompiledRoute[];

  constructor(config: ModelRouterConfig) {
    this.defaultModel = config.defaultModel;
    this.cheapModel = config.cheapModel ?? null;
    this.complexityThreshold = config.complexityThreshold ?? 120;
    this.routes = (config.routes ?? []).map((r) => ({
      patterns: r.patterns.map((p) => new RegExp(p, "i")),
      model: r.model,
    }));
  }

  /**
   * Resolve the best model for a given message.
   * Returns the model ref string (e.g. "anthropic/claude-haiku-3-5").
   */
  resolve(messageText: string): { model: string; reason: string } {
    // 1. Pattern-based routes take priority
    for (const route of this.routes) {
      for (const pattern of route.patterns) {
        if (pattern.test(messageText)) {
          return { model: route.model, reason: `pattern:${pattern.source}` };
        }
      }
    }

    // 2. Short/simple messages → cheap model
    if (this.cheapModel && messageText.length < this.complexityThreshold) {
      return { model: this.cheapModel, reason: "short-message" };
    }

    // 3. Default model for everything else
    return { model: this.defaultModel, reason: "default" };
  }
}

// ── Singleton ──────────────────────────────────────────────────────────

let instance: ModelRouter | null = null;

export function getModelRouter(): ModelRouter | null {
  return instance;
}

export function initModelRouter(config: ModelRouterConfig): ModelRouter {
  instance = new ModelRouter(config);
  return instance;
}
