import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Test configuration.
 *
 * This replaces a hand-rolled harness of 13 esbuild-plus-node invocations, one per module. That
 * setup worked, but a new suite cost two npm scripts and a bundler invocation — which is the real
 * reason the harder modules were never covered. Here a new suite costs a file.
 *
 * **Electron is aliased, not mocked.** `resolve.alias` points at the same `scripts/electron-stub.mjs`
 * the old harness used and which is already proven against this code. `vi.mock('electron')` is the
 * more fashionable answer but has a known failure mode for packages without a `main` entry, and
 * this migration is a port — swapping the mechanism at the same time would make a green run
 * meaningless.
 *
 * Two environments, because the renderer needs a DOM and the main process must not have one. A
 * `core` module that accidentally reaches for `document` should fail, not silently pass.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Only `app.getPath` is needed; see the stub.
      electron: resolve('scripts/electron-stub.mjs'),
      // Must mirror tsconfig.json and electron.vite.config.ts.
      '@core': resolve('src/core'),
      '@main': resolve('src/main'),
      '@shared': resolve('src/shared'),
    },
  },
  test: {
    projects: [
      {
        // Main and shared: plain node, no DOM.
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/{main,shared,preload}/**/*.test.ts'],
        },
      },
      {
        // Renderer: jsdom rather than happy-dom — dnd-kit is particular about layout APIs.
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.ts?(x)'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      // Reported, not enforced — a threshold across Electron-coupled files that structurally
      // cannot be unit-tested would just be a number nobody can move.
      reporter: ['text-summary', 'html'],
    },
  },
});
