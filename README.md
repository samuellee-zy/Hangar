# Hangar

A unified workspace for web apps on macOS — one window, isolated sessions per account, no
subscription and no cloud account. Built as a replacement for Rambox, whose workspaces, multi-login,
unlimited instances and custom apps all sit behind a paid tier.

Your configuration lives in `~/Library/Application Support/Hangar/config.json` and nowhere else.
No telemetry, no server-side copy of your service list.

## Quickstart

```bash
npm install
```

**Then run Electron's postinstall by hand.** npm 11's `allow-scripts` gate silently skips it, and
without the binary `electron-vite preview` fails with a bare "Electron uninstall":

```bash
node node_modules/electron/install.js
```

```bash
npm run build && npm start
```

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
| `npm run icons` | Re-vendor catalog icons from dashboard-icons |

## Testing

There's no unit-test surface for the shell itself — it's integration with third-party web
properties, verified by using it. What *is* tested is the pure logic where a mistake is silent and
expensive. **140 checks across 12 suites**, each bundling one module with esbuild and running it under
plain node, so they're fast and need no Electron.

| Suite | Covers |
| --- | --- |
| `check:config-store` | Atomic writes, corrupt-file quarantine, backup recovery — the highest-stakes tests here |
| `check:layout` | Pane geometry across all four rail positions, and pane lifecycle |
| `check:shortcuts` | Key translation, and that a listener can't be double-registered |
| `check:accounts` | The v1→v2 migration preserves every partition name |
| `check:add` | Adding services, second accounts, custom URLs and their host allowlists |
| `check:preferences` | Defaults merging and `set-preference` validation |
| `check:folders` | The rail tree's invariants and the v3→v4 migration |
| `check:workspaces` | Workspace lifecycle, and that deletion never strands a service |
| `check:hibernate` | Which services are eligible to unload, and what reloads after a wake |
| `check:notifications` | Banner-vs-count policy, DND, muting, badge totals |
| `check:permissions` | Permission policy by provenance, deny-by-default, orphan partition detection |
| `check:recovery` | Which load failures matter, retry backoff, crash recovery, error-page escaping |

There's also `HANGAR_PROBE=1`, which opens the picker on launch, reports what the rail and overlay
actually rendered, and clicks a tile with a **real input event**. It exists because renderer
failures are invisible from the terminal — see [decisions #14](docs/decisions.md).

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
| [decisions.md](docs/decisions.md) | **46 findings that cost real time. Read before changing behaviour.** |

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
