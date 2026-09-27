/**
 * Architectural boundaries, enforced.
 *
 * The point of `src/core/` is that it contains no Electron. Until now that was a convention held by
 * hand — nothing stopped a pure module gaining an `import { app } from 'electron'`, and it would
 * only have been caught if that module happened to have a test. These rules turn the convention
 * into a build failure.
 *
 * It's also what makes the core genuinely extractable later. A single npm package is the right
 * choice today, but if `core/` ever needs to become one — for a web build, a CLI, a different shell
 * — the work is a `git mv` plus a manifest *provided the boundary actually held*. That's what this
 * proves, continuously, rather than being discovered to be false on the day it matters.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-is-electron-free',
      severity: 'error',
      comment:
        'src/core must never import electron. This is the whole point of the directory: it is the ' +
        'part that can be tested under plain node and reused outside a desktop shell.',
      from: { path: '^src/core' },
      // Matched on the RESOLVED path. '^electron$' silently never matches, because what the graph
      // holds is 'node_modules/electron/index.js' — and a boundary rule that never fires is worse
      // than no rule, since it reads as proof. Verified by adding a deliberate violation.
      to: { path: 'node_modules/electron/' },
    },
    {
      name: 'core-has-no-ui',
      severity: 'error',
      comment:
        'src/core must never import react or reach into the renderer. Domain logic that knows how ' +
        'it is displayed cannot be reused by anything that displays it differently.',
      from: { path: '^src/core' },
      // Resolved paths again — see core-is-electron-free.
      to: { path: 'node_modules/(react|react-dom|@dnd-kit)/|^src/renderer' },
    },
    {
      name: 'core-does-not-depend-on-main',
      severity: 'error',
      comment:
        'Dependencies point inward: main may use core, never the reverse. An arrow back out is how ' +
        'a "pure" module quietly acquires the whole Electron graph.',
      from: { path: '^src/core' },
      to: { path: '^src/(main|preload)' },
    },
    {
      name: 'renderer-is-sandboxed',
      severity: 'error',
      comment:
        'The renderer is a separate process; it can only reach main through the preload bridge. An ' +
        'import here would bundle main-process code into the page and fail at runtime, not build.',
      from: { path: '^src/renderer' },
      to: { path: '^src/(main|core)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A cycle means neither module can be understood, tested or moved on its own — and under ESM ' +
        'it can also produce a partially-initialised import that is undefined at module scope.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'A module nothing imports is usually a leftover from a refactor. Entry points and type-only ' +
        'modules are exempt below — dependency-cruiser cannot see a type-only import, so those ' +
        'would otherwise be permanent false positives.',
      from: {
        orphan: true,
        pathNot: [
          // Entry points: reached by the bundler or Electron, not by an import.
          '^src/main/boot/index\\.ts$',
          '^src/preload/',
          '^src/renderer/main\\.tsx$',
          // Type-only modules. Their exports are only ever imported as types, which erases at
          // compile time, so the graph shows nothing pointing at them.
          '^src/shared/types\\.ts$',
          '^src/core/push/types\\.ts$',
          '\\.d\\.ts$',
          // Config and tooling at the repo root.
          '^(\\.|[^/]+\\.(js|cjs|mjs|ts))$',
        ],
      },
      to: {},
    },
    {
      name: 'no-dev-deps-in-src',
      severity: 'error',
      comment:
        'A devDependency imported by shipped code is missing at runtime in the packaged app — ' +
        'electron-builder prunes them. `electron` itself is the exception: it is correctly a ' +
        'devDependency because the runtime provides it rather than the bundle. The renderer is ' +
        'exempt for the opposite reason: Vite bundles everything it imports, so React and dnd-kit ' +
        'are build inputs — as dependencies they were shipped a second time, unused, in the asar.',
      from: { path: '^src/', pathNot: ['\\.test\\.ts$', '^src/renderer/'] },
      // Matched on the RESOLVED path — 'electron' alone never matches node_modules/electron.
      to: { dependencyTypes: ['npm-dev'], pathNot: 'node_modules/electron/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(out|dist|build|coverage|spikes)/' },
    // MANDATORY, not optional: without it every @core/@main/@shared import misresolves and the
    // rules quietly pass on a graph that isn't the real one.
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
