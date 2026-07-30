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

### Main

| File | Owns |
| --- | --- |
| `index.ts` | Boot order, single-instance lock, IPC surface, background loops, `powerMonitor` |
| `window.ts` | Composition: window, rail, panes, overlay. The `dispatch` switch |
| `layout.ts` | Pane geometry, rail placement, window-button position. Pure |
| `service-manager.ts` | View lifecycle per service, custom CSS/JS injection |
| `session.ts` | Partitions, permissions, navigation guards, spellcheck, downloads |
| `accounts.ts` | Accounts, partition assignment, v1→v2 migration. Pure |
| `folders.ts` | The rail tree and its invariants, v3→v4 migration. Pure |
| `preferences.ts` | Defaults-as-schema, merging, validated `setPreference`. Pure |
| `hibernate.ts` | Which services are eligible to unload or refresh. Pure |
| `notifications.ts` | Banner/count policy and badge totals. Pure |
| `permissions.ts` | Permission policy and orphan partition detection. Pure |
| `recovery.ts` | Load-failure policy, retry backoff, the in-pane error page. Pure |
| `workspaces.ts` | Workspace lifecycle and orphan rehoming. Pure |
| `overlay.ts` | The palette / picker layer |
| `push.ts` | Web Push policy — pure ([push.md](push.md)) |
| `push-manager.ts` | FCM sockets, registration, reconnect |
| `find-bar.ts` | Find in page — its own small view, not the overlay ([decisions #38](decisions.md)) |
| `context-menu.ts` | Native menus for web views, rail tiles, folders, rail background |
| `shortcuts.ts` | `before-input-event` translation |
| `menu.ts` | Application menu — and therefore ownership of ⌘W |
| `icons.ts` | `hangar-icon://` and `hangar-catalog://`, favicon capture and sniffing |
| `system.ts` | Login item, proxy, downloads, the one global shortcut |
| `tray.ts` | Menu-bar icon, unread count, jump list |
| `transfer.ts` | Config export / import |
| `settings-window.ts` | The ⌘, `BrowserWindow` |
| `quit-state.ts` | Real-quit vs close-to-tray flag, isolated to avoid an import cycle |
| `config-store.ts` | Atomic writes, corrupt-file quarantine, rolling backup. Pure |
| `persist-cookies.ts` | Session-cookie promotion and flushing |
| `renderer-url.ts` | Route loading and console forwarding |
| `ua.ts` | The user-agent scrub |

### Renderer and shared

| File | Owns |
| --- | --- |
| `renderer/Rail.tsx` | The rail: tree rendering, orientation, tiles |
| `renderer/OverlayRoot.tsx` | Switches the overlay between palette and picker |
| `renderer/Settings.tsx` | Every settings section |
| `renderer/PreferenceControls.tsx` | Toggle / Choice / Num, each a thin `set-preference` sender |
| `renderer/accent.ts` | Lifts brand colours to a readable contrast on dark tiles |
| `shared/` | Types and catalog. Imported by both sides, so **no Electron imports allowed** |

**The pure modules are pure on purpose.** `layout`, `accounts`, `folders`, `preferences`,
`hibernate` and `config-store` import nothing from Electron, which is what lets `npm run check`
exercise them under plain node in milliseconds. Keep it that way — a stray `import { app }` costs a
whole test suite.

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
