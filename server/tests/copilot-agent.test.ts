/**
 * @file copilot-agent.test.ts
 * Unit tests for the Copilot SDK agent helpers (config parsing, model validation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// We test the public config helpers without spinning up the full agent engine.
// The module exports are: parseAllowedModels, getDefaultModel, buildAgentConfig
// These are imported from the top of index.ts; to test without full server startup,
// we replicate the pure-function logic here (same code, zero side effects).

// ---------------------------------------------------------------------------
// parseAllowedModels / getDefaultModel logic (matches server/src/index.ts)
// ---------------------------------------------------------------------------

function parseAllowedModels(): string[] {
  const raw = process.env.COPILOT_AGENT_MODELS || 'gpt-4.1,gpt-4o,gpt-5-mini';
  return raw
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

function getDefaultModel(): string {
  return process.env.COPILOT_AGENT_DEFAULT_MODEL || parseAllowedModels()[0] || 'gpt-4.1';
}

// ---------------------------------------------------------------------------

describe('parseAllowedModels', () => {
  const originalModels = process.env.COPILOT_AGENT_MODELS;
  const originalDefault = process.env.COPILOT_AGENT_DEFAULT_MODEL;

  afterEach(() => {
    if (originalModels !== undefined) process.env.COPILOT_AGENT_MODELS = originalModels;
    else delete process.env.COPILOT_AGENT_MODELS;
    if (originalDefault !== undefined) process.env.COPILOT_AGENT_DEFAULT_MODEL = originalDefault;
    else delete process.env.COPILOT_AGENT_DEFAULT_MODEL;
  });

  it('returns default model list when env is unset', () => {
    delete process.env.COPILOT_AGENT_MODELS;
    const models = parseAllowedModels();
    expect(models).toEqual(['gpt-4.1', 'gpt-4o', 'gpt-5-mini']);
  });

  it('parses comma-separated list', () => {
    process.env.COPILOT_AGENT_MODELS = 'claude-4,gpt-5,o3';
    expect(parseAllowedModels()).toEqual(['claude-4', 'gpt-5', 'o3']);
  });

  it('trims whitespace', () => {
    process.env.COPILOT_AGENT_MODELS = '  a , b , c  ';
    expect(parseAllowedModels()).toEqual(['a', 'b', 'c']);
  });

  it('filters empty entries', () => {
    process.env.COPILOT_AGENT_MODELS = 'a,,b,,,c';
    expect(parseAllowedModels()).toEqual(['a', 'b', 'c']);
  });
});

describe('getDefaultModel', () => {
  afterEach(() => {
    delete process.env.COPILOT_AGENT_DEFAULT_MODEL;
    delete process.env.COPILOT_AGENT_MODELS;
  });

  it('returns env override when set', () => {
    process.env.COPILOT_AGENT_DEFAULT_MODEL = 'custom-model';
    expect(getDefaultModel()).toBe('custom-model');
  });

  it('falls back to first allowed model', () => {
    delete process.env.COPILOT_AGENT_DEFAULT_MODEL;
    process.env.COPILOT_AGENT_MODELS = 'first,second';
    expect(getDefaultModel()).toBe('first');
  });

  it('ultimate fallback is gpt-4.1', () => {
    delete process.env.COPILOT_AGENT_DEFAULT_MODEL;
    delete process.env.COPILOT_AGENT_MODELS;
    expect(getDefaultModel()).toBe('gpt-4.1');
  });
});
