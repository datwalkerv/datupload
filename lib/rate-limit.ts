import "server-only";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window resets. */
  retryAfter: number;
}

/**
 * Anything that can answer "may `key` make another request?".
 * Swap the in-memory implementation for a Redis-backed one (for example Upstash's
 * `@upstash/ratelimit`) by implementing this interface and changing `rateLimiter` below.
 */
export interface RateLimiter {
  limit(key: string, max: number, windowMs: number): Promise<RateLimitResult>;
}

/**
 * Fixed-window counter kept in process memory. On serverless platforms each instance
 * has its own counters, so this is a best-effort guard rather than a global quota.
 */
export class MemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  async limit(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    this.sweep(now);

    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count++;

    return {
      allowed: window.count <= max,
      remaining: Math.max(0, max - window.count),
      retryAfter: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }

  reset() {
    this.windows.clear();
  }

  private lastSweep = 0;
  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

export const rateLimiter: RateLimiter & { reset?: () => void } = new MemoryRateLimiter();
