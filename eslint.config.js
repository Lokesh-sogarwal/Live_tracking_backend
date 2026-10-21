import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'var/**', 'coverage/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }], 'no-console': 'warn' },
  },
  { files: ['scripts/**'], rules: { 'no-console': 'off' } },
  // Playwright harness: page.evaluate() callbacks run in the browser.
  { files: ['scripts/sim-e2e/**'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['tests/**'], languageOptions: { globals: { ...globals.node, ...globals.vitest } } },
];
