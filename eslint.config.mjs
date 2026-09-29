// @ts-check
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Lint for the mistakes the compiler can't see, and nothing else.
 *
 * Not a style guide: formatting and naming are left to the code around them, and the recommended
 * sets are not enabled wholesale — most of their rules restate what `tsc --strict` already checks.
 * What is here earns its place by being a bug:
 *
 * - An un-awaited promise in main. A rejection nobody handles is at best a log line, and before
 *   decisions #98 it was a modal that froze the process. The codebase marks deliberate
 *   fire-and-forget with `void`; this makes the undeliberate kind an error.
 * - A promise handed to something that expects a plain callback — an `ipcMain.on` handler, an event
 *   listener — where the rejection has nowhere to go.
 * - The rules of hooks, and hooks reading values their dependency lists leave out.
 */
export default tseslint.config(
  // coverage/ is `npm run test:coverage`'s report, generated like out/.
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'spikes/**', 'out-check/**', 'coverage/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
