/**
 * Token Bucket Rate Limiter
 *
 * Implements a token bucket algorithm for rate limiting HTTP requests.
 * Each IP address gets a bucket that refills at a constant rate.
 *
 * BACKWARD COMPATIBLE:
 * - This module is opt-in and must be explicitly enabled in configuration
 * - When disabled (default), all requests pass through without rate limiting
 */

export interface RateLimiterConfig {
  /**
   * Maximum number of tokens in a bucket (burst capacity)
   * Default: 30 requests
   */
  maxTokens?: number;

  /**
   * Refill rate in tokens per minute
   * Default: 30 tokens per minute (0.5 tokens/second)
   */
  tokensPerMinute?: number;

  /**
   * How often to clean up stale buckets (in milliseconds)
   * Default: 5 minutes
   */
  cleanupIntervalMs?: number;

  /**
   * Consider a bucket stale if not accessed for this duration (in milliseconds)
   * Default: 15 minutes
   */
  staleThresholdMs?: number;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Token Bucket Rate Limiter
 *
 * Uses a token bucket algorithm where each request consumes 1 token.
 * Tokens refill at a constant rate (tokensPerMinute).
 * If a bucket has no tokens, the request is rate-limited.
 */
export class RateLimiter {
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per millisecond
  private readonly cleanupIntervalMs: number;
  private readonly staleThresholdMs: number;

  private buckets = new Map<string, TokenBucket>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: RateLimiterConfig = {}) {
    this.maxTokens = config.maxTokens ?? 30;
    this.cleanupIntervalMs = config.cleanupIntervalMs ?? 5 * 60 * 1000; // 5 minutes
    this.staleThresholdMs = config.staleThresholdMs ?? 15 * 60 * 1000; // 15 minutes

    // Convert tokens per minute to tokens per millisecond
    const tokensPerMinute = config.tokensPerMinute ?? 30;
    this.refillRate = tokensPerMinute / 60_000;

    // Start cleanup timer
    this.startCleanup();
  }

  /**
   * Try to consume a token from the bucket for the given key
   *
   * @param key - Identifier for the bucket (usually IP address)
   * @returns true if token consumed (request allowed), false if rate limited
   */
  tryConsume(key: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      // Create new bucket with full capacity
      bucket = {
        tokens: this.maxTokens,
        lastRefill: now
      };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on time elapsed
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;

    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    // Try to consume 1 token
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    // Rate limited
    return false;
  }

  /**
   * Get current status for a key (useful for debugging)
   *
   * @param key - Identifier for the bucket
   * @returns Current bucket status or null if bucket doesn't exist
   */
  getStatus(key: string): { tokens: number; maxTokens: number } | null {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      return null;
    }

    // Calculate current tokens (with refill)
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;
    const currentTokens = Math.min(this.maxTokens, bucket.tokens + tokensToAdd);

    return {
      tokens: Math.floor(currentTokens),
      maxTokens: this.maxTokens
    };
  }

  /**
   * Reset a specific bucket (useful for testing or admin override)
   *
   * @param key - Identifier for the bucket to reset
   */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Reset all buckets
   */
  resetAll(): void {
    this.buckets.clear();
  }

  /**
   * Get number of active buckets
   */
  getBucketCount(): number {
    return this.buckets.size;
  }

  /**
   * Start automatic cleanup of stale buckets
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);

    // Don't prevent process from exiting
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Remove stale buckets to prevent memory leaks
   */
  private cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, bucket] of this.buckets.entries()) {
      const age = now - bucket.lastRefill;
      if (age > this.staleThresholdMs) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.buckets.delete(key);
    }
  }

  /**
   * Stop the cleanup timer
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

/**
 * Create a rate limiter from configuration
 *
 * @param enabled - Whether rate limiting is enabled
 * @param config - Rate limiter configuration
 * @returns RateLimiter instance or null if disabled
 */
export function createRateLimiter(
  enabled: boolean,
  config: RateLimiterConfig = {}
): RateLimiter | null {
  return enabled ? new RateLimiter(config) : null;
}
