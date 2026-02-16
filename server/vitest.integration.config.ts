import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/mcp-protocol.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 10_000,
  },
});
