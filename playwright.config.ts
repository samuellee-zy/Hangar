import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests against the real Electron app.
 *
 * These replace `HANGAR_PROBE`, which drove the same paths but reported with `console.log` — so it
 * could tell a human something was broken and could not fail a build. Everything here either
 * passes or stops the run.
 *
 * Deliberately serial with one worker: each test launches a real Electron instance holding a
 * single-instance lock, and parallel runs would fight over it.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  // Electron launch plus a page load is slow; the default 30s trips on a cold start.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // On CI, an HTML report as well: the workflow uploads `playwright-report/` on failure, and with
  // only the list reporter that directory never existed.
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // One retry on CI, traced. A test that passes on its retry is reported as flaky rather than
  // failing the build — and the trace of the failed attempt is what says why.
  retries: process.env['CI'] ? 1 : 0,
  use: { trace: process.env['CI'] ? 'on-first-retry' : 'retain-on-failure' },
});
