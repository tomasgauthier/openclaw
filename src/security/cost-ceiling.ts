/**
 * Daily cost ceiling enforcement.
 *
 * Tracks cumulative API costs in-memory and blocks new requests when the
 * configured daily ceiling is reached. Resets automatically at midnight.
 *
 * Usage:
 *   initCostCeiling(0, 10.0);          // On startup
 *   recordCost(0.003);                  // After each API response
 *   if (isCostCeilingHit()) { ... }     // Before starting a new agent turn
 */

const DEFAULT_CEILING_USD = 10.0;

let dailyCostAccumulator = 0;
let currentDay = "";
let ceilingUsd = DEFAULT_CEILING_USD;
let enabled = true;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function maybeResetDay(): void {
  const today = todayKey();
  if (today !== currentDay) {
    dailyCostAccumulator = 0;
    currentDay = today;
  }
}

/**
 * Initialize the cost ceiling tracker.
 * @param initialDailyCost - Cost already accumulated today (from scanning transcripts)
 * @param ceiling - Daily ceiling in USD (default: $10)
 * @param isEnabled - Whether cost ceiling enforcement is enabled (default: true)
 */
export function initCostCeiling(
  initialDailyCost: number = 0,
  ceiling?: number,
  isEnabled?: boolean,
): void {
  dailyCostAccumulator = initialDailyCost;
  currentDay = todayKey();
  if (ceiling !== undefined) {
    ceilingUsd = Math.max(0, ceiling);
  }
  if (isEnabled !== undefined) {
    enabled = isEnabled;
  }
}

export function setCostCeiling(ceiling: number): void {
  ceilingUsd = Math.max(0, ceiling);
}

export function setCostCeilingEnabled(value: boolean): void {
  enabled = value;
}

/** Record an API cost increment (call after each model response). */
export function recordCost(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    return;
  }
  maybeResetDay();
  dailyCostAccumulator += amount;
}

export function getDailyCostStatus(): {
  spent: number;
  ceiling: number;
  remaining: number;
  blocked: boolean;
  enabled: boolean;
} {
  maybeResetDay();
  const remaining = Math.max(0, ceilingUsd - dailyCostAccumulator);
  return {
    spent: dailyCostAccumulator,
    ceiling: ceilingUsd,
    remaining,
    blocked: enabled && dailyCostAccumulator >= ceilingUsd,
    enabled,
  };
}

/** Returns true if the daily cost ceiling has been reached and enforcement is enabled. */
export function isCostCeilingHit(): boolean {
  if (!enabled) {
    return false;
  }
  maybeResetDay();
  return dailyCostAccumulator >= ceilingUsd;
}
