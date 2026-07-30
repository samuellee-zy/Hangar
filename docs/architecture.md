# Architecture

## Process and view model

One `BaseWindow` containing native `WebContentsView`s. The panes are **not** DOM elements — each is
a separate renderer process. That single fact drives most of the design: anything spanning the rail
and a pane (drag, keyboard routing, z-order, context menus) must be coordinated by the main process,
because the two sides cannot see each other.

```
BaseWindow
├── WebContentsView  rail       → renderer #rail        (any edge; frameless, drag handle)
├── WebContentsView  service…   → persist:<account>     (1–4 panes, inset rounded cards)
└── WebContentsView  overlay    → renderer #overlay     (attached on demand, removed on close)

BrowserWindow       settings    → renderer #settings    (separate window, ⌘,)
Tray                            → menu bar
```

## Main owns all state

The renderer holds none. It receives a `ShellState` and sends a `Command`; that is the entire
surface, and it is why a visual redesign is a rewrite of `src/renderer/` with no main-process churn.

```
rail / overlay / settings ──Command──▶ ipcMain ──▶ AppWindow.dispatch
                                                        │
                                                        ▼
                                          Layout · ServiceManager · Config · folders
                                                        │
        ◀────────── ShellState ◀──── sync() ────────────┘
                     (broadcast to every registered consumer)
```

Two rules make this hold:

**Every mutation goes through `dispatch`, and every mutation ends in `sync()`.** `sync()` broadcasts
to *all* registered consumers via `registerConsumer()`. Sending to one surface is what left the
connection picker rendering a stale snapshot ([decisions #17](decisions.md)).

**`dispatch` returns a boolean** — whether it acted. The keyboard layer uses it to decide whether to
swallow the keystroke, which is what lets Escape close our overlay *and* still reach Slack's dialogs
when the overlay is closed.

If you find yourself caching shell state in a component, that's the bug.

## Modules

Two top-level directories, and the split is enforced rather than intended — `npm run check` runs
`dependency-cruiser` and fails the build on any arrow that crosses the wrong way.

### `src/core/` — pure

No `electron`, no `react`, no imports from `main/` or `renderer/`. Everything here is a fold over
data, which is why nearly all the test coverage lives on this side. It's also the part that could
become its own package: the boundary is what makes that a `git mv` rather than an excavation.

| Path | Role |
| --- | --- |
| `config/preferences.ts` | Defaults-as-schema; `setPreference` validates every IPC write |
| `config/store.ts` | Atomic write, corrupt-file quarantine, rolling backup ([#28](decisions.md), [#47](decisions.md)) |
| `config/migrate.ts` | v1→v4 in one place, shared by load *and* import ([#58](decisions.md)) |
| `services/accounts.ts` | Account identity; partition names are never recomputed |
| `workspace/{workspaces,folders,layout}.ts` | Rail tree, one level deep; pane geometry for all four rail positions |
| `notify/policy.ts` | Banner-vs-count decision, including DND and window visibility |
| `notify/unread.ts` | Counts keyed by service id, outliving the view ([#56](decisions.md)) |
| `push/policy.ts` | Eligibility, replay suppression, payload extraction, backoff |
| `runtime/{hibernate,recovery,permissions}.ts` | Sleep policy, failure classification, per-service permission grants |
| `shell-state.ts` | `projectShellState`, `resolveCommand`, `removeServiceFromConfig` |

### `src/main/` — Electron adapters

| Path | Role |
| --- | --- |
| `boot/index.ts` | Entry point: boot order, single-instance lock, IPC surface, background loops |
| `boot/menu.ts` | The application menu — owning it is the only way to own ⌘W ([#11](decisions.md)) |
| `window/app-window.ts` | Composition root. `dispatch`, `sync`, `relayout`, `dispose` |
| `window/service-manager.ts` | A `WebContentsView` per service; load, sleep, recover |
| `window/overlay.ts` | Palette and picker layer, attached on demand |
| `window/shortcuts.ts` | `before-input-event` accelerators |
| `features/` | push-manager, find-bar, tray, settings-window, transfer, icons, context-menu |
| `platform/` | config, session, persist-cookies, system, ua, quit-state, renderer-url |

### Dependency direction

```
renderer ──IPC──▶ main ──▶ core
                            ▲
                  shared ───┘   (types + catalog; imported by all three)
```

Enforced rules: `core` may not import `electron`, `react`, `main` or `renderer`; `renderer` may not
import `main` or `core`; no cycles anywhere. Each rule was verified by deliberately introducing a
violation and confirming it failed — three of them were initially misconfigured and passing on a
graph they weren't actually looking at ([#53](decisions.md)).

## Rules worth stating

**Never hide an attached overlay.** A transparent `WebContentsView` hit-tests across its whole
bounds, so leaving it attached but invisible swallows every click and looks like the app has frozen.
Add on open, remove on close.

**Never derive a partition name from mutable data.** See [decisions #7](decisions.md).

**Never write config non-atomically, and never overwrite one that failed to parse.** See
[decisions #28](decisions.md) — this was a total-data-loss bug.

**Never sleep a visible service.** See [decisions #22](decisions.md).

**A preload cannot patch the page's `window`.** With `contextIsolation`, page-level patches must go
through `contextBridge.executeInMainWorld` ([decisions #31](decisions.md)) — this was silent for
three separate patches.

**Push-only IPC races a view that hasn't loaded.** Pull on mount, then subscribe
([decisions #13](decisions.md)).

## Boot order

Order matters more than usual:

1. `app.setName` — before the menu, or the menu bar reads "Electron"
2. `registerIconScheme()` — must precede app-ready
3. `applyUserAgent()` — first thing *inside* `whenReady` (it reads `session.defaultSession`, which
   throws earlier) and before any session or view exists
4. `loadConfig()` → `nativeTheme.themeSource` → `installIconProtocol()`
5. `new AppWindow()` → `installMenu()` → `applySystemPreferences()`

## Diagnostics

Renderer failures are invisible from the terminal, which cost three round trips before these
existed. Keep both:

- **`forwardConsole()`** pipes renderer errors and warnings into the main log, tagged by route.
- **`HANGAR_PROBE=1`** opens the picker on launch, reports what the rail and overlay rendered, and
  clicks a tile with `sendInputEvent`. Note the distinction that matters: `element.click()` proves a
  handler is wired and nothing else — only a real input event proves the view receives input
  ([decisions #18](decisions.md)).

Also: `ipcMain.on('shell:command')` wraps dispatch in a try/catch and logs the command name. An
exception thrown there otherwise surfaces nowhere and looks exactly like a dead button.

## Config versions

Migrations apply on load and are cumulative. `saveConfig` runs immediately after one, so the upgrade
is durable even if the app is killed straight afterwards.

| Version | Change |
| --- | --- |
| v1 | Original. Services carried a `sessionGroup` string |
| v2 | Session groups became first-class **Accounts** with immutable partitions |
| v3 | **Preferences** added — purely additive, filled from defaults |
| v4 | `Workspace.serviceIds` became an ordered **`RailItem[]`** tree (folders) |

## Code conventions

Every module opens with a comment saying what it owns and any non-obvious constraint. Inline
comments explain *why*, never *what* — if a line needs explaining because of what it does, rename
something instead.

Comments earn their place by recording a decision or a trap. `ua.ts`, `persist-cookies.ts`,
`preferences.ts` and `hibernate.ts` are the reference for tone: each explains something that cost
time to learn and would otherwise look like an arbitrary choice ready to be "cleaned up".
