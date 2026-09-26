# Hangar

[![CI](https://github.com/samuellee-zy/Hangar/actions/workflows/ci.yml/badge.svg)](https://github.com/samuellee-zy/Hangar/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A unified workspace for web apps on macOS — one window, isolated sessions per account, no
subscription and no cloud account. Built as a replacement for Rambox, whose workspaces, multi-login,
unlimited instances and custom apps all sit behind a paid tier.

Your configuration lives in `~/Library/Application Support/Hangar/config.json` and nowhere else.
No telemetry, no server-side copy of your service list.

**Who it's for:** anyone who keeps eight browser tabs permanently open for work, wants two Gmail
accounts signed in at once without a second browser profile, and would rather not rent that. It is a
personal project shared publicly, not a product — see [Status](#status) for what isn't built.

## Quickstart

Requires macOS and Node 22.22.2+ (CI runs 24; `.nvmrc` pins it).

```bash
npm install
npm run install:local
```

`npm install` also fetches the Electron binary — Electron 43 has no postinstall of its own, so this
package runs its `install-electron` for it. `install:local` builds for this Mac, signs it, and
installs it into `/Applications`, replacing and restarting a running copy. Run it again after any
change. The build itself needs no network.

To run from the repo instead, without installing: `npm start` (which builds first) or `npm run dev`.

### Signing, and why a local build needs it

There is no Developer ID certificate. `install:local` signs each build anyway, because macOS
**drops notifications for an unsigned app** without a word. By default it signs ad-hoc, which is
enough for notifications, but macOS then asks again for camera and microphone after every rebuild.
Run this once to make a local certificate, and those grants stick:

```bash
npm run cert:local
```

A bundle you built yourself is not quarantined, so there is no Gatekeeper prompt. `npm run dist`
still makes an unsigned DMG for someone else; on their Mac it opens via System Settings → Privacy &
Security → **Open Anyway** (macOS 15 removed the right-click → Open bypass). Homebrew stopped
accepting casks that fail Gatekeeper on **1 September 2026**, so distribution beyond "build it
yourself" needs a Developer ID. Details: [packaging.md](docs/packaging.md).

## What it does

**Panes.** 1–4 web views side by side, inset as rounded cards. `⌘\` splits, `⌘⌥←/→` moves focus.
The arrangement is remembered per workspace across restarts.

**Accounts and multi-login.** An account owns one cookie jar. Gmail, Calendar and Drive share one
Google login; a *second* Gmail gets its own. Unlimited, because a partition costs nothing.

**Workspaces and folders.** Separate rails for separate contexts, each remembering its own pane
layout, switchable with ⌘⌥1…9. Folders group services within a rail, one level deep, with unread
rolled up.

**Connections.** A catalog of common services with real logos, plus any website by URL — those get
their favicon captured from the page itself.

**Notifications.** A service's own notifications are intercepted and attributed, so the dock badge,
tray count and folder roll-ups all reflect real unread. Do Not Disturb silences the banner but keeps
counting; muting a service does neither.

**Configurable.** Rail on any edge, theme, density, rail size, labels, hibernation, tray, launch at
login, global shortcut, proxy, downloads, per-service zoom and custom CSS/JS.

**Web Push** — a hibernated service can still reach you, so sleeping one is a saving rather than
silence. Needs a free Firebase project of your own; see [push.md](docs/push.md) for why.

**Browser affordances.** Find in page (⌘F) with match counts, zoom per service (⌘+/−/0), print,
and a window title that follows the focused service.

**Right-click everywhere** — including inside the web views, where Electron gives you nothing by
default: copy/paste, open-link-in-browser, and spelling suggestions.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | electron-vite dev server with HMR |
| `npm run dev:isolated` | The same, on a separate profile. Needed once the packaged app is installed — the single-instance lock is keyed on `userData`, so otherwise the dev copy hands off to the running one and exits |
| `npm start` | Build and run the production bundle |
| `npm run check` | Typecheck `src` and `tests`, run Vitest, enforce the module boundaries. The one to run before committing |
| `npm test` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with coverage |
| `npm run test:e2e` | Build, then the Playwright suite against a real Electron |
| `npm run typecheck` / `typecheck:tests` | Either half of `check`'s typechecking on its own |
| `npm run check:boundaries` | `dependency-cruiser` alone |
| `npm run graph` | Render the dependency graph to SVG. Needs Graphviz |
| `npm run install:local` | Build for this Mac, sign, install into `/Applications`, restart it. The one to run after a change |
| `npm run cert:local` | Once, optionally: a local signing certificate, so camera and microphone grants survive rebuilds |
| `npm run dist` | Unsigned DMG into `dist/` |
| `npm run dist:signed` | The same with a Developer ID, if you have one |
| `npm run icons` | Re-vendor catalog icons from dashboard-icons |
| `npm run icon` | Rebuild the app icon itself, `.icns` from the SVG |

`dev`, `start` and `icon` go through `scripts/run-electron.mjs`, which strips an inherited
`ELECTRON_RUN_AS_NODE`. Some terminals set it, and with it set Electron runs as plain Node — the app
exits instantly with no window and no error.

## Testing

**Vitest for the logic, Playwright for the window**, plus `dependency-cruiser` enforcing the module
boundaries on every run. `npm run check` prints the current totals — they are deliberately not
written here, having drifted three times in files that claimed two different numbers at once.

The architecture is what makes this possible: `src/core/` is pure — no Electron, no React — so its
logic runs under plain node with no window. That isn't a convention any more; `npm run check` fails
the build if a `core` module imports `electron`, and each rule was verified by deliberately breaking
it ([decisions #53](docs/decisions.md)).

| Area | Covers |
| --- | --- |
| `config-store` | Atomic writes, corrupt-file quarantine, backup recovery, and that an **empty** config is valid rather than corrupt — the highest-stakes tests here |
| `migrate` | v1/v2 → current end to end; partition names byte-identical; refuses input that would silently sign you out |
| `shell-state` | State projection, `#n`/`#focused` resolution, and that removing a service touches all five structures that reference it |
| `layout` | Pane geometry across all four rail positions, and pane lifecycle |
| `shortcuts` | Every chord, and that a listener can't be double-registered |
| `accounts` | The v1→v2 migration preserves every partition name |
| `add-service` | Adding services, second accounts, custom URLs and their host allowlists |
| `preferences` | Defaults merging and `set-preference` validation, to three levels deep |
| `folders` / `workspaces` | Rail-tree invariants, migrations, and that deletion never strands a service |
| `hibernate` | Which services are eligible to unload, and what reloads after a wake |
| `notifications` | Banner-vs-count policy, DND, muting, window visibility, badge totals |
| `permissions` | Policy by provenance, deny-by-default, orphan partition detection |
| `recovery` | Which load failures matter, retry backoff, crash recovery, error-page escaping |
| `push` / `push-manager` | Eligibility, replay suppression, payload extraction across six shapes, backoff; reconnect on wake |
| `endpoint` | Asking a sleeping service's own API for its unread count, and the jitter that stops every service asking at once after a wake |
| `keyboard` | Rebinding, conflict detection, displacement, and the chords that refuse to be rebound |
| `drop` | Where a dragged tile lands: replace a pane, open one, or nothing |
| `effects` | That every preference path maps to the side effect it needs — the guard against a setting that saves and does nothing |
| `sync` / `sync-lifecycle` / `sync-guard` | The allowlist, the three-way decision, teardown, and the public-repo guard |
| `launch-agent` | The launchd plist, including that a deliberate quit stays quit |
| `resilience` | That a dead terminal mutes logging instead of killing the app |
| `cookies` | Session-cookie promotion, including the `__Host-` rules that had silently never worked |
| `accent` | Contrast lifting, and that no input can produce invalid CSS |
| `catalog` | Data invariants: unique ids, icon files exist, every entry allows its own URL |
| `tests/renderer/*` | React components under `@testing-library/react`: the rail, each Settings section, the drag layer, the error boundary |

```bash
npm run test:e2e
```

The Playwright tests cover what unit tests structurally can't: real windows, real
`WebContentsView` hit-testing, the preload's main-world patches, and process lifecycle — a
hibernated service receiving a push, ⌘W then reopening, a truncated config being quarantined.

Each was verified by **reintroducing the bug it guards** and confirming it failed. Every run gets
its own `userData` and a local fixture server, so they touch nothing real and pass on a machine
that has never opened Gmail.

## Docs

| | |
| --- | --- |
| [architecture.md](docs/architecture.md) | Process model, view tree, state flow, boot order, conventions |
| [connections.md](docs/connections.md) | Catalog vs instance vs account; folders; custom connections |
| [preferences.md](docs/preferences.md) | Every setting, what it does, and what isn't wired yet |
| [icons.md](docs/icons.md) | Icon sourcing, protocols, CSP |
| [keyboard.md](docs/keyboard.md) | Shortcut map, context menus, and why it works the way it does |
| [backlog.md](docs/backlog.md) | **What isn't done**, and why — blockers, gaps, deferred work |
| [packaging.md](docs/packaging.md) | Building the DMG, signing, the asar trap |
| [push.md](docs/push.md) | Web Push setup and design |
| [sync.md](docs/sync.md) | Config sync across machines: setup, what travels, conflicts |
| [decisions.md](docs/decisions.md) | **Every finding that cost real time. Start here.** |

## Status

**Built:** the shell (panes, palette, keyboard, application menu, context menus), accounts and
multi-login, icons, the connection picker with custom URLs, folders, rail reordering, dragging a
tile onto a pane, dragging one into and out of a folder, the compact rail's chevron, keyboard
rebinding with per-service passthrough, unread from the page's own badge and from a sleeping
service's own API, Web Push, the preferences system with a Settings window and reset-to-defaults,
rail placement on any edge, theming, hibernation, `powerMonitor` handling, tray, git-backed config
sync, config export/import, and launch-at-login with optional relaunch — which works on an unsigned
build, via a LaunchAgent rather than the API macOS refuses ([decisions #93](docs/decisions.md)).

**Not built:**

- **Service APIs.** The tier above session-borrowed endpoints needs a token, and that is a decision
  rather than a function: OAuth clients need a secret an open-source binary cannot hold, and the
  personal-token services need somewhere to keep one that git sync will not publish
  ([decisions #91](docs/decisions.md)).
- **Unread selectors for eight of the catalog's services.** The mechanism ships; the selectors are
  deliberately not guessed ([decisions #90](docs/decisions.md)).

## Contributing

`main` is protected: it requires a pull request, one code-owner approval, and a green CI run
(`npm run check` plus the E2E suite on macOS). Fork, branch, open a PR.

Before changing behaviour, read [decisions.md](docs/decisions.md). It is a long list of things that
looked correct, passed their tests, and were wrong anyway — a duplicated block that fired a full
sync on an unrelated click, a "Keep repo" button that did the opposite of its label, three
dependency rules that silently matched nothing. The recurring lesson is that **verification has to
be adversarial**: if you add a guard, break the thing it guards and watch it fail. Several guards
here were found to be inert exactly that way, after months of passing.

## Licence

MIT — see [LICENSE](LICENSE).

One exception: the service icons under `assets/icons/` are vendored from
[dashboard-icons](https://github.com/homarr-labs/dashboard-icons) under Apache-2.0 and are **not**
covered by that grant. Brand marks remain the property of their respective owners. The attribution
lives in [assets/icons/NOTICE](assets/icons/NOTICE) and ships inside the packaged app — the
`extraResources` filter in `electron-builder.yml` explicitly lets `NOTICE` through for that reason.
