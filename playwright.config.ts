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
  reporter: process.env['CI'] ? 'list' : [['list']],
  use: { trace: 'retain-on-failure' },
});
