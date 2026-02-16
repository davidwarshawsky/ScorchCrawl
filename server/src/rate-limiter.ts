/**
 * Rate Limiting, Concurrency Control & Quota Monitoring
 *
 * The Copilot SDK / CLI engine handles HTTP-level rate limiting automatically:
 *   - 429 retries (up to 5) with exponential backoff + jitter
 *   - `retry-after` header respect
 *   - HTTP/2 GOAWAY recovery
 *   - 402 quota-exceeded errors surfaced as session.error
 *
 * This module adds the APPLICATION-LEVEL safeguards that the SDK doesn't:
 *   1. Per-user and global concurrency limits for agent jobs
 *   2. Quota snapshot tracking with proactive rejection
 *   3. Sliding-window request rate tracking to avoid hitting 429 at all
 *   4. Stale job garbage collection
 *   5. Error classification and hook configuration
 */

// ---------------------------------------------------------------------------
// Configuration (from env or defaults)
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Max concurrent agent jobs across ALL users (default: 10) */
  maxGlobalConcurrency: number;
  /** Max concurrent agent jobs per user token (default: 3) */
  maxPerUserConcurrency: number;
  /** Sliding-window size in ms for request rate tracking (default: 60_000 = 1 min) */
  rateLimitWindowMs: number;
  /** Max requests in the sliding window per user (default: 20) */
  maxRequestsPerWindow: number;
  /** Max requests in the sliding window globally (default: 60) */
  maxGlobalRequestsPerWindow: number;
  /** Minimum remaining quota % before proactively rejecting (default: 5) */
  quotaRejectThresholdPercent: number;
  /** Max age for a "processing" job before it's considered stale (default: 10 min) */
  staleJobTimeoutMs: number;
  /** How often to run GC for stale jobs and old timestamps (default: 60s) */
  gcIntervalMs: number;
}

export function buildRateLimitConfig(): RateLimitConfig {
  return {
    maxGlobalConcurrency: envInt('RATE_LIMIT_MAX_GLOBAL_CONCURRENCY', 10),
    maxPerUserConcurrency: envInt('RATE_LIMIT_MAX_PER_USER_CONCURRENCY', 3),
    rateLimitWindowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000),
    maxRequestsPerWindow: envInt('RATE_LIMIT_MAX_REQUESTS_PER_WINDOW', 20),
    maxGlobalRequestsPerWindow: envInt('RATE_LIMIT_MAX_GLOBAL_REQUESTS_PER_WINDOW', 60),
    quotaRejectThresholdPercent: envInt('RATE_LIMIT_QUOTA_REJECT_PERCENT', 5),
    staleJobTimeoutMs: envInt('RATE_LIMIT_STALE_JOB_TIMEOUT_MS', 10 * 60 * 1000),
    gcIntervalMs: envInt('RATE_LIMIT_GC_INTERVAL_MS', 60_000),
  };
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v == null) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  /** Seconds until the caller should retry (hint for 429-style responses) */
  retryAfterSeconds?: number;
}

export interface QuotaInfo {
  remainingPercent: number;
  usedRequests: number;
  entitlementRequests: number;
  isUnlimited: boolean;
  resetDate?: string;
  lastUpdated: number;
}

// ---------------------------------------------------------------------------
// ConcurrencyTracker
// ---------------------------------------------------------------------------

/**
 * Tracks in-flight agent jobs both globally and per-user.
 * Call `acquire()` before starting a job, `release()` when done.
 */
export class ConcurrencyTracker {
  private globalActive = 0;
  private perUser = new Map<string, number>();

  constructor(private config: RateLimitConfig) {}

  /** Check if a new job is allowed for the given user key */
  canAcquire(userKey: string): RateLimitResult {
    if (this.globalActive >= this.config.maxGlobalConcurrency) {
      return {
        allowed: false,
        reason: `Server is at maximum capacity (${this.config.maxGlobalConcurrency} concurrent jobs). Please retry shortly.`,
        retryAfterSeconds: 10,
      };
    }
    const userCount = this.perUser.get(userKey) || 0;
    if (userCount >= this.config.maxPerUserConcurrency) {
      return {
        allowed: false,
        reason: `You already have ${userCount} concurrent agent jobs (max ${this.config.maxPerUserConcurrency}). Wait for a job to complete before starting another.`,
        retryAfterSeconds: 15,
      };
    }
    return { allowed: true };
  }

  acquire(userKey: string): void {
    this.globalActive++;
    this.perUser.set(userKey, (this.perUser.get(userKey) || 0) + 1);
  }

  release(userKey: string): void {
    this.globalActive = Math.max(0, this.globalActive - 1);
    const cur = this.perUser.get(userKey) || 0;
    if (cur <= 1) {
      this.perUser.delete(userKey);
    } else {
      this.perUser.set(userKey, cur - 1);
    }
  }

  /** Current stats (for observability / health endpoint) */
  stats(): { global: number; perUser: Record<string, number> } {
    return {
      global: this.globalActive,
      perUser: Object.fromEntries(this.perUser),
    };
  }
}

// ---------------------------------------------------------------------------
// SlidingWindowRateLimiter
// ---------------------------------------------------------------------------

/**
 * Sliding-window rate limiter that tracks request timestamps.
 * This prevents us from *sending* too many requests in the first place,
 * so we rarely hit the API-level 429.
 */
export class SlidingWindowRateLimiter {
  /** Map<userKey, timestamp[]> */
  private perUser = new Map<string, number[]>();
  private globalTimestamps: number[] = [];

  constructor(private config: RateLimitConfig) {}

  check(userKey: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.config.rateLimitWindowMs;

    // --- Global check ---
    this.globalTimestamps = this.globalTimestamps.filter((t) => t > windowStart);
    if (this.globalTimestamps.length >= this.config.maxGlobalRequestsPerWindow) {
      const oldest = this.globalTimestamps[0]!;
      const retryAfter = Math.ceil((oldest + this.config.rateLimitWindowMs - now) / 1000);
      return {
        allowed: false,
        reason: `Global rate limit reached (${this.config.maxGlobalRequestsPerWindow} requests per ${this.config.rateLimitWindowMs / 1000}s window). Please wait.`,
        retryAfterSeconds: Math.max(1, retryAfter),
      };
    }

    // --- Per-user check ---
    let userTs = this.perUser.get(userKey) || [];
    userTs = userTs.filter((t) => t > windowStart);
    this.perUser.set(userKey, userTs);

    if (userTs.length >= this.config.maxRequestsPerWindow) {
      const oldest = userTs[0]!;
      const retryAfter = Math.ceil((oldest + this.config.rateLimitWindowMs - now) / 1000);
      return {
        allowed: false,
        reason: `Rate limit reached (${this.config.maxRequestsPerWindow} requests per ${this.config.rateLimitWindowMs / 1000}s window). Please wait.`,
        retryAfterSeconds: Math.max(1, retryAfter),
      };
    }

    return { allowed: true };
  }

  /** Record that a request was made */
  record(userKey: string): void {
    const now = Date.now();
    this.globalTimestamps.push(now);
    const userTs = this.perUser.get(userKey) || [];
    userTs.push(now);
    this.perUser.set(userKey, userTs);
  }

  /** Purge old timestamps (called by GC) */
  gc(): void {
    const cutoff = Date.now() - this.config.rateLimitWindowMs;
    this.globalTimestamps = this.globalTimestamps.filter((t) => t > cutoff);
    for (const [key, ts] of this.perUser) {
      const filtered = ts.filter((t) => t > cutoff);
      if (filtered.length === 0) {
        this.perUser.delete(key);
      } else {
        this.perUser.set(key, filtered);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// QuotaMonitor
// ---------------------------------------------------------------------------

/**
 * Tracks Copilot quota snapshots per user to proactively reject requests
 * when quota is about to be exhausted.
 *
 * Quota data is fed from Copilot session `assistant.usage` events.
 */
export class QuotaMonitor {
  private perUser = new Map<string, QuotaInfo>();

  constructor(private config: RateLimitConfig) {}

  /** Update quota snapshot for a user (call from session event handler) */
  update(userKey: string, snapshot: Partial<QuotaInfo>): void {
    const existing = this.perUser.get(userKey);
    this.perUser.set(userKey, {
      remainingPercent: snapshot.remainingPercent ?? existing?.remainingPercent ?? 100,
      usedRequests: snapshot.usedRequests ?? existing?.usedRequests ?? 0,
      entitlementRequests: snapshot.entitlementRequests ?? existing?.entitlementRequests ?? -1,
      isUnlimited: snapshot.isUnlimited ?? existing?.isUnlimited ?? false,
      resetDate: snapshot.resetDate ?? existing?.resetDate,
      lastUpdated: Date.now(),
    });
  }

  /** Check if the user has sufficient quota to start a new agent job */
  check(userKey: string): RateLimitResult {
    const info = this.perUser.get(userKey);

    // No quota info yet → allow (first request, or info not yet retrieved)
    if (!info) return { allowed: true };

    // Unlimited entitlement → always allow
    if (info.isUnlimited) return { allowed: true };

    // Stale quota info (> 5 min old) → allow but log warning
    if (Date.now() - info.lastUpdated > 5 * 60 * 1000) {
      return { allowed: true };
    }

    if (info.remainingPercent <= this.config.quotaRejectThresholdPercent) {
      const resetMsg = info.resetDate
        ? ` Quota resets on ${info.resetDate}.`
        : '';
      return {
        allowed: false,
        reason: `Copilot quota nearly exhausted (${info.remainingPercent.toFixed(1)}% remaining, ${info.usedRequests}/${info.entitlementRequests} used).${resetMsg} Upgrade your plan or wait for reset.`,
      };
    }

    return { allowed: true };
  }

  /** Get quota info for a user (for diagnostics) */
  get(userKey: string): QuotaInfo | undefined {
    return this.perUser.get(userKey);
  }

  /** Purge old entries (called by GC) */
  gc(): void {
    const cutoff = Date.now() - 30 * 60 * 1000; // 30 min
    for (const [key, info] of this.perUser) {
      if (info.lastUpdated < cutoff) {
        this.perUser.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Unified RateLimitGuard
// ---------------------------------------------------------------------------

/**
 * Facade that combines concurrency tracking, sliding-window rate limiting,
 * and quota monitoring into a single `guard.check()` call.
 */
export class RateLimitGuard {
  readonly config: RateLimitConfig;
  readonly concurrency: ConcurrencyTracker;
  readonly rateLimit: SlidingWindowRateLimiter;
  readonly quota: QuotaMonitor;
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: RateLimitConfig) {
    this.config = config || buildRateLimitConfig();
    this.concurrency = new ConcurrencyTracker(this.config);
    this.rateLimit = new SlidingWindowRateLimiter(this.config);
    this.quota = new QuotaMonitor(this.config);

    // Start periodic GC
    this.gcTimer = setInterval(() => {
      this.rateLimit.gc();
      this.quota.gc();
    }, this.config.gcIntervalMs);

    // Don't block process exit
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  /**
   * Check ALL rate-limit gates in priority order.
   * Returns the first rejection, or { allowed: true } if all pass.
   */
  check(userKey: string): RateLimitResult {
    // 1. Concurrency (cheapest check)
    const concResult = this.concurrency.canAcquire(userKey);
    if (!concResult.allowed) return concResult;

    // 2. Sliding-window rate limit
    const rateResult = this.rateLimit.check(userKey);
    if (!rateResult.allowed) return rateResult;

    // 3. Quota (proactive rejection)
    const quotaResult = this.quota.check(userKey);
    if (!quotaResult.allowed) return quotaResult;

    return { allowed: true };
  }

  /** Record that a request was admitted and is now in-flight */
  acquire(userKey: string): void {
    this.concurrency.acquire(userKey);
    this.rateLimit.record(userKey);
  }

  /** Release concurrency slot when job finishes */
  release(userKey: string): void {
    this.concurrency.release(userKey);
  }

  /** Stats for observability */
  stats(): Record<string, unknown> {
    return {
      concurrency: this.concurrency.stats(),
      config: {
        maxGlobalConcurrency: this.config.maxGlobalConcurrency,
        maxPerUserConcurrency: this.config.maxPerUserConcurrency,
        maxRequestsPerWindow: this.config.maxRequestsPerWindow,
        rateLimitWindowMs: this.config.rateLimitWindowMs,
        quotaRejectThresholdPercent: this.config.quotaRejectThresholdPercent,
      },
    };
  }

  /** Clean shutdown */
  shutdown(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Copilot SDK session error hook factory
// ---------------------------------------------------------------------------

/**
 * Build an `onErrorOccurred` hook for Copilot SDK sessions.
 *
 * This integrates with the SDK's ErrorOccurredHookOutput to make
 * intelligent retry/skip/abort decisions:
 *   - model_call + recoverable → retry (up to 2 extra)
 *   - tool_execution → skip the failed tool, continue agent
 *   - quota / auth errors → abort immediately
 */
export function buildErrorHook(
  jobId: string,
  logger?: { warn: (...args: unknown[]) => void }
) {
  return (input: {
    error: string;
    errorContext: 'model_call' | 'tool_execution' | 'system' | 'user_input';
    recoverable: boolean;
  }) => {
    const log = logger || console;
    log.warn(`[RateLimit] Agent ${jobId} error`, {
      context: input.errorContext,
      recoverable: input.recoverable,
      error: input.error.substring(0, 200),
    });

    // Quota / auth errors → abort immediately, don't waste retries
    const lowerErr = input.error.toLowerCase();
    if (
      lowerErr.includes('quota') ||
      lowerErr.includes('402') ||
      lowerErr.includes('not licensed') ||
      lowerErr.includes('authentication')
    ) {
      return { errorHandling: 'abort' as const, suppressOutput: false };
    }

    // Rate limit errors after SDK exhausted its 5 retries → abort
    if (lowerErr.includes('rate limit') || lowerErr.includes('429')) {
      return {
        errorHandling: 'abort' as const,
        suppressOutput: false,
        userNotification: 'Rate limit reached. Please retry later.',
      };
    }

    // Model call errors that are recoverable → retry up to 2 additional times
    if (input.errorContext === 'model_call' && input.recoverable) {
      return { errorHandling: 'retry' as const, retryCount: 2 };
    }

    // Tool execution errors → skip the failed tool, let agent continue
    if (input.errorContext === 'tool_execution') {
      return { errorHandling: 'skip' as const };
    }

    // Everything else → abort
    return { errorHandling: 'abort' as const };
  };
}

// ---------------------------------------------------------------------------
// Stale job reaper (for copilot-agent.ts to call)
// ---------------------------------------------------------------------------

export interface StaleJobCandidate {
  id: string;
  status: string;
  createdAt: number;
}

/**
 * Identify agent jobs that have been "processing" longer than the timeout.
 * The caller is responsible for actually marking/removing them.
 */
export function findStaleJobs(
  jobs: Iterable<StaleJobCandidate>,
  timeoutMs: number
): string[] {
  const now = Date.now();
  const stale: string[] = [];
  for (const job of jobs) {
    if (job.status === 'processing' && now - job.createdAt > timeoutMs) {
      stale.push(job.id);
    }
  }
  return stale;
}
