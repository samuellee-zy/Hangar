import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: resolve('src/main/index.ts') } },
  },
  preload: {
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
    root: resolve('src/renderer'),
    plugins: [react()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
