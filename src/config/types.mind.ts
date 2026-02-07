/**
 * Configuration types for the Spiritual Biology / Mind system.
 */

export type MindConfig = {
  /** Enable the mind system (default: true). */
  enabled?: boolean;
  /** Cron expression for automatic dream phase (default: "0 3 * * *" = 3 AM daily). */
  dreamCron?: string;
  /** Decay factor per dream cycle (default: 0.95). */
  decayFactor?: number;
  /** Minimum relevance before pruning (default: 0.1). */
  minRelevance?: number;
  /** Relevance boost on activation (default: 0.15). */
  reactivationBoost?: number;
  /** Stress detection mode: "regex" (fast), "semantic" (embedding-based), or "off" (default: "regex"). */
  stressDetection?: "regex" | "semantic" | "off";
};
