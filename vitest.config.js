import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/globalSetup.js'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['tests/**/*.test.js'],
  },
});
