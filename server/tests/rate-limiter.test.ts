/**
 * @file rate-limiter.test.ts
 * Unit tests for ScorchCrawl rate limiting, concurrency, and quota modules.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ConcurrencyTracker,
  SlidingWindowRateLimiter,
  QuotaMonitor,
  RateLimitGuard,
  buildRateLimitConfig,
  buildErrorHook,
  findStaleJobs,
  type RateLimitConfig,
} from '../src/rate-limiter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testConfig(overrides: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    maxGlobalConcurrency: 3,
    maxPerUserConcurrency: 2,
    rateLimitWindowMs: 1000,
    maxRequestsPerWindow: 5,
    maxGlobalRequestsPerWindow: 10,
    quotaRejectThresholdPercent: 5,
    staleJobTimeoutMs: 5000,
    gcIntervalMs: 60_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ConcurrencyTracker
// ---------------------------------------------------------------------------

describe('ConcurrencyTracker', () => {
  let tracker: ConcurrencyTracker;

  beforeEach(() => {
    tracker = new ConcurrencyTracker(testConfig());
  });

  it('allows acquisition when under limits', () => {
    expect(tracker.canAcquire('user-a').allowed).toBe(true);
  });

  it('blocks when global concurrency is reached', () => {
    tracker.acquire('a');
    tracker.acquire('b');
    tracker.acquire('c');
    const result = tracker.canAcquire('d');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('maximum capacity');
  });

  it('blocks when per-user concurrency is reached', () => {
    tracker.acquire('a');
    tracker.acquire('a');
    const result = tracker.canAcquire('a');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('concurrent agent jobs');
  });

  it('allows after release', () => {
    tracker.acquire('a');
    tracker.acquire('a');
    tracker.release('a');
    expect(tracker.canAcquire('a').allowed).toBe(true);
  });

  it('release never goes negative', () => {
    tracker.release('nonexistent');
    const stats = tracker.stats();
    expect(stats.global).toBe(0);
  });

  it('stats reflects current state accurately', () => {
    tracker.acquire('x');
    tracker.acquire('y');
    const stats = tracker.stats();
    expect(stats.global).toBe(2);
    expect(stats.perUser).toEqual({ x: 1, y: 1 });
  });
});

// ---------------------------------------------------------------------------
// SlidingWindowRateLimiter
// ---------------------------------------------------------------------------

describe('SlidingWindowRateLimiter', () => {
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowRateLimiter(
      testConfig({ maxRequestsPerWindow: 3, maxGlobalRequestsPerWindow: 5, rateLimitWindowMs: 500 })
    );
  });

  it('allows requests under the per-user limit', () => {
    expect(limiter.check('u1').allowed).toBe(true);
    limiter.record('u1');
    expect(limiter.check('u1').allowed).toBe(true);
  });

  it('blocks per-user requests over the limit', () => {
    for (let i = 0; i < 3; i++) {
      limiter.record('u1');
    }
    const result = limiter.check('u1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('blocks global requests over the limit', () => {
    for (let i = 0; i < 5; i++) {
      limiter.record(`user-${i}`);
    }
    const result = limiter.check('new-user');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Global rate limit');
  });

  it('allows again after window expires', async () => {
    for (let i = 0; i < 3; i++) limiter.record('u1');
    expect(limiter.check('u1').allowed).toBe(false);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 550));
    expect(limiter.check('u1').allowed).toBe(true);
  });

  it('gc purges old timestamps', async () => {
    limiter.record('u1');
    await new Promise((r) => setTimeout(r, 550));
    limiter.gc();
    // After GC, the old timestamp is purged; 3 new requests should be fine
    for (let i = 0; i < 3; i++) limiter.record('u1');
    // This means the old one didn't count
    expect(limiter.check('u1').allowed).toBe(false); // 3 = limit
  });
});

// ---------------------------------------------------------------------------
// QuotaMonitor
// ---------------------------------------------------------------------------

describe('QuotaMonitor', () => {
  let monitor: QuotaMonitor;

  beforeEach(() => {
    monitor = new QuotaMonitor(testConfig({ quotaRejectThresholdPercent: 10 }));
  });

  it('allows when no quota info exists', () => {
    expect(monitor.check('u1').allowed).toBe(true);
  });

  it('allows when user has unlimited entitlement', () => {
    monitor.update('u1', { isUnlimited: true, remainingPercent: 0 });
    expect(monitor.check('u1').allowed).toBe(true);
  });

  it('allows when remaining is above threshold', () => {
    monitor.update('u1', {
      remainingPercent: 50,
      usedRequests: 500,
      entitlementRequests: 1000,
      isUnlimited: false,
    });
    expect(monitor.check('u1').allowed).toBe(true);
  });

  it('blocks when remaining is at or below threshold', () => {
    monitor.update('u1', {
      remainingPercent: 5,
      usedRequests: 950,
      entitlementRequests: 1000,
      isUnlimited: false,
    });
    const result = monitor.check('u1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('quota nearly exhausted');
  });

  it('allows when quota info is stale (> 5 min)', () => {
    monitor.update('u1', { remainingPercent: 1, isUnlimited: false });
    // Manually age the entry
    const info = monitor.get('u1')!;
    info.lastUpdated = Date.now() - 6 * 60 * 1000;
    expect(monitor.check('u1').allowed).toBe(true);
  });

  it('gc removes old entries', () => {
    monitor.update('u1', { remainingPercent: 50, isUnlimited: false });
    const info = monitor.get('u1')!;
    info.lastUpdated = Date.now() - 35 * 60 * 1000; // > 30 min
    monitor.gc();
    expect(monitor.get('u1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RateLimitGuard (integration of all three)
// ---------------------------------------------------------------------------

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;

  beforeEach(() => {
    guard = new RateLimitGuard(testConfig());
  });

  afterEach(() => {
    guard.shutdown();
  });

  it('allows when all gates pass', () => {
    expect(guard.check('u1').allowed).toBe(true);
  });

  it('rejects when concurrency is exhausted', () => {
    guard.acquire('a');
    guard.acquire('b');
    guard.acquire('c');
    expect(guard.check('d').allowed).toBe(false);
  });

  it('rejects when rate limit is exhausted', () => {
    for (let i = 0; i < 5; i++) guard.rateLimit.record('u1');
    expect(guard.check('u1').allowed).toBe(false);
  });

  it('rejects when quota is low', () => {
    guard.quota.update('u1', { remainingPercent: 2, isUnlimited: false });
    expect(guard.check('u1').allowed).toBe(false);
  });

  it('acquire + release cycle works', () => {
    guard.acquire('u1');
    expect(guard.concurrency.stats().global).toBe(1);
    guard.release('u1');
    expect(guard.concurrency.stats().global).toBe(0);
  });

  it('stats returns meaningful data', () => {
    guard.acquire('u1');
    const stats = guard.stats();
    expect(stats).toHaveProperty('concurrency');
    expect(stats).toHaveProperty('config');
  });
});

// ---------------------------------------------------------------------------
// buildRateLimitConfig (env parsing)
// ---------------------------------------------------------------------------

describe('buildRateLimitConfig', () => {
  it('returns defaults when no env vars set', () => {
    const cfg = buildRateLimitConfig();
    expect(cfg.maxGlobalConcurrency).toBe(10);
    expect(cfg.maxPerUserConcurrency).toBe(3);
  });

  it('reads env vars', () => {
    process.env.RATE_LIMIT_MAX_GLOBAL_CONCURRENCY = '99';
    const cfg = buildRateLimitConfig();
    expect(cfg.maxGlobalConcurrency).toBe(99);
    delete process.env.RATE_LIMIT_MAX_GLOBAL_CONCURRENCY;
  });

  it('falls back to default for non-numeric env', () => {
    process.env.RATE_LIMIT_MAX_GLOBAL_CONCURRENCY = 'abc';
    const cfg = buildRateLimitConfig();
    expect(cfg.maxGlobalConcurrency).toBe(10);
    delete process.env.RATE_LIMIT_MAX_GLOBAL_CONCURRENCY;
  });
});

// ---------------------------------------------------------------------------
// buildErrorHook
// ---------------------------------------------------------------------------

describe('buildErrorHook', () => {
  it('aborts on quota errors', () => {
    const hook = buildErrorHook('job-1');
    const result = hook({
      error: 'Quota exceeded: 402 payment required',
      errorContext: 'model_call',
      recoverable: true,
    });
    expect(result.errorHandling).toBe('abort');
  });

  it('aborts on rate limit errors', () => {
    const hook = buildErrorHook('job-2');
    const result = hook({
      error: 'Rate limit exceeded 429',
      errorContext: 'model_call',
      recoverable: false,
    });
    expect(result.errorHandling).toBe('abort');
  });

  it('retries recoverable model call errors', () => {
    const hook = buildErrorHook('job-3');
    const result = hook({
      error: 'Temporary server error',
      errorContext: 'model_call',
      recoverable: true,
    });
    expect(result.errorHandling).toBe('retry');
  });

  it('skips tool execution errors', () => {
    const hook = buildErrorHook('job-4');
    const result = hook({
      error: 'Tool timed out',
      errorContext: 'tool_execution',
      recoverable: false,
    });
    expect(result.errorHandling).toBe('skip');
  });

  it('aborts on unknown non-recoverable errors', () => {
    const hook = buildErrorHook('job-5');
    const result = hook({
      error: 'Something completely unexpected',
      errorContext: 'system',
      recoverable: false,
    });
    expect(result.errorHandling).toBe('abort');
  });
});

// ---------------------------------------------------------------------------
// findStaleJobs
// ---------------------------------------------------------------------------

describe('findStaleJobs', () => {
  it('returns empty for no stale jobs', () => {
    const jobs = [
      { id: 'a', status: 'processing', createdAt: Date.now() },
      { id: 'b', status: 'completed', createdAt: Date.now() - 999999 },
    ];
    expect(findStaleJobs(jobs, 5000)).toEqual([]);
  });

  it('identifies stale processing jobs', () => {
    const jobs = [
      { id: 'old', status: 'processing', createdAt: Date.now() - 10000 },
      { id: 'new', status: 'processing', createdAt: Date.now() },
    ];
    expect(findStaleJobs(jobs, 5000)).toEqual(['old']);
  });

  it('ignores non-processing jobs regardless of age', () => {
    const jobs = [
      { id: 'done', status: 'completed', createdAt: 0 },
      { id: 'err', status: 'failed', createdAt: 0 },
    ];
    expect(findStaleJobs(jobs, 5000)).toEqual([]);
  });
});
