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

Requires macOS and Node 22.12+ (CI runs 24).

```bash
npm install
```

**Then fetch the Electron binary.** Electron 43 has no postinstall — it ships an explicit
`install-electron` bin instead — so a fresh install leaves `node_modules/electron` with no binary
and no `path.txt`. Running the `electron` CLI downloads on demand, but anything that resolves the
path first (Playwright's `_electron.launch`, `electron-vite preview`) fails before that happens:

```bash
npx install-electron
```

```bash
npm run build && npm start
```

### Running an unsigned build

There is no Developer ID certificate, so `npm run dist` produces an unsigned, un-notarised DMG.
macOS will refuse to open it on a double-click. Right-click the app → **Open** → **Open**, once;
after that it launches normally. Worth knowing that Homebrew stops accepting casks that fail
Gatekeeper on **1 September 2026**, so distribution beyond "build it yourself" would need signing.

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
| `npm start` | Build and run the production bundle |
| `npm run check` | Typecheck plus every logic check |
| `npm run test:e2e` | Build, then the Playwright suite against a real Electron |
| `npm run dist` | Unsigned DMG into `dist/` |
| `npm run icons` | Re-vendor catalog icons from dashboard-icons |

## Testing

**350 tests under Vitest, plus 15 Playwright end-to-end tests**, plus `dependency-cruiser` enforcing the module boundaries on every run.

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
| `push` | Eligibility, replay suppression, payload extraction across six shapes, backoff |
| `accent` | Contrast lifting, and that no input can produce invalid CSS |
| `catalog` | Data invariants: unique ids, icon files exist, every entry allows its own URL |

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
| [decisions.md](docs/decisions.md) | **84 findings that cost real time. Start here.** |

## Status

**Built:** the shell (panes, palette, keyboard, application menu, context menus), accounts and
multi-login, icons, the connection picker with custom URLs, folders, rail reordering, the
preferences system with a Settings window, rail placement on any edge, theming, hibernation,
`powerMonitor` handling, tray, and config export/import.

**Not built:**

- **Dragging a tile onto a pane.** Rail reordering works; cross-pane drop needs the overlay drag
  layer ([decisions #10](docs/decisions.md)).
- **Dragging a service into a folder.** Use right-click → Move to folder.
- **Keyboard rebinding.** Settings shows the map read-only.
- **Compact rail is a narrower rail, not hover-expand.** Expanding on hover needs the rail view to
  overlay the panes, and it's added first so it sits underneath.
- **The integration tiers** — session-borrowed endpoints, Web Push, service APIs. The thing that
  motivated the tiered design in the first place.

## Contributing

`main` is protected: it requires a pull request, one code-owner approval, and a green CI run
(`npm run check` plus the E2E suite on macOS). Fork, branch, open a PR.

Before changing behaviour, read [decisions.md](docs/decisions.md). It is 84 entries of things that
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
