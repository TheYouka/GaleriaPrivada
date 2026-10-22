import { defineConfig } from '@playwright/test';

// E2E con _electron contra out/ (no hace falta instalar navegadores).
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results',
});
