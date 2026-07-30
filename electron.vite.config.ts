import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Path aliases make the module boundary visible at every import site: `@core/...` is pure domain
 * logic, `@main/...` is Electron. A `@core` file importing `@main` is then obvious in review, and
 * dependency-cruiser fails the build on it.
 *
 * Declared in three places — here, tsconfig.json and vitest.config.ts — because each resolves
 * imports independently. They have to stay in step.
 */
const alias = {
  '@core': resolve('src/core'),
  '@main': resolve('src/main'),
  '@shared': resolve('src/shared'),
};

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: resolve('src/main/boot/index.ts') } },
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Two preloads: one for the sidebar (our own UI), one injected into every service view.
        input: {
          sidebar: resolve('src/preload/sidebar.ts'),
          service: resolve('src/preload/service.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: { alias },
    root: resolve('src/renderer'),
    plugins: [react()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
