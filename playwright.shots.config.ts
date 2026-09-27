import { defineConfig } from '@playwright/test';

/**
 * Screenshots of the real window, for looking at — not a test suite, and never run in CI.
 *
 * Playwright's own screenshots stop at the web contents, and most of what goes wrong with the
 * window chrome is outside them: the traffic lights are native, and so is the strip they sit in.
 * These capture the screen instead, so they need a Mac with Screen Recording allowed for whatever
 * runs them. `npm run shots`, then look in test-results/shots/.
 */
export default defineConfig({
  testDir: './e2e-shots',
  testMatch: '**/*.shots.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
});
