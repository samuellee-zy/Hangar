# Architecture

## Process and view model

One `BaseWindow` containing native `WebContentsView`s. The panes are **not** DOM elements — each is
a separate renderer process. That single fact drives most of the design: anything spanning the rail
and a pane (drag, keyboard routing, z-order, context menus) must be coordinated by the main process,
because the two sides cannot see each other.

Back to front — the order is the z-order, and `relayout` re-establishes it on every pass:

```
BaseWindow
├── View             focus ring                          (index 0: a coloured card behind the focused pane)
├── WebContentsView  service…   → persist:<account>     (1–4 panes, inset rounded cards)
├── WebContentsView  empty      → renderer #empty       (only when no pane can be filled)
├── WebContentsView  rail       → renderer #rail        (any edge; frameless, drag handle)
├── WebContentsView  find bar   → renderer #find        (attached on demand)
├── WebContentsView  overlay    → renderer #overlay     (attached on demand, removed on close)
└── WebContentsView  drag layer → renderer #drag        (attached last, only while a tile is out of the rail)

BrowserWindow       settings    → renderer #settings    (separate window, ⌘,)
Tray                            → menu bar
```

The rail is in front of the panes deliberately. It was behind them for a long time — it was
attached first — which was invisible while it only ever occupied space the panes had been denied,
and became a blocker the moment it needed to grow over them (decisions #88). It no longer does —
the panes reflow around an opened rail (#95) — but a pane whose bounds are a frame stale still
mustn't cover it, and `relayout` re-raises it only when one does.

Anything attached on demand is also *detached*, never hidden: a `WebContentsView` hit-tests across
its whole bounds whether or not you can see it, so one left attached swallows every click in the
window.

## Main owns all state

The renderer holds none. It receives a `ShellState` and sends a `Command`, and that one pair carries
every state change — which is why a visual redesign is a rewrite of `src/renderer/` with no
main-process churn.

```
rail / overlay / settings ──Command──▶ ipcMain ──▶ AppWindow.dispatch
                                                        │
                                                        ▼
                            Layout · ServiceManager · Config · folders · ConfigSync
                            EndpointPoller · PushManager · preference effects
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

### What sits around that pair

The `ShellState`/`Command` pair is the *state* surface, not the whole of IPC. Beside it are a pull
channel and a handful of pushes, each there for a reason the broadcast can't serve: `shell:get-state`
because a view that mounts after a broadcast would otherwise sit empty until the next one
([#13](decisions.md)); `find:opened` / `find:result`, `overlay:mode` and `drag:highlight` /
`drag:ended` because they are transient interaction state with no business in config. The service
preload is a separate bridge again — `service:notification`, `service:unread`, the push handshake —
because it runs inside a page that must not reach the shell's surface at all. All of it is registered
in one block in `boot/index.ts`, so the surface can be read rather than discovered.

One naming collision worth knowing: `sync()` here means "broadcast the `ShellState`". Config sync,
the git feature, is unrelated — see [sync.md](sync.md).

## Modules

Five directories under `src/`: `core`, `main`, `preload`, `renderer` and `shared`. The split between
the first two is the load-bearing one, and it is enforced rather than intended — `npm run check` runs
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
| `config/effects.ts` | Which side effect a changed preference path needs — the map behind `applyPreferenceEffect` |
| `config/sync.ts` | What travels between machines and what stays: allowlist, three-way decision, conflicts never auto-merged ([#74](decisions.md), [#78](decisions.md)) |
| `config/launch-agent.ts` | The launchd plist, rendered from two preferences ([#93](decisions.md)) |
| `services/accounts.ts` | Account identity; partition names are never recomputed |
| `workspace/{workspaces,folders,layout}.ts` | Rail tree, one level deep; pane geometry for all four rail positions |
| `workspace/drop.ts` | Where a dragged tile would land: replace a pane, open one, or nothing ([#86](decisions.md), [#87](decisions.md)) |
| `notify/policy.ts` | Banner-vs-count decision, including DND and window visibility |
| `notify/unread.ts` | Counts keyed by service id, outliving the view ([#56](decisions.md)); title and DOM detection ([#90](decisions.md)) |
| `notify/endpoint.ts` | Rule shape and extraction for asking a sleeping service's own API ([#91](decisions.md)) |
| `push/{policy,types}.ts` | Eligibility, replay suppression, payload extraction, backoff. The types are separate so the policy stays free of the receiver's node imports |
| `runtime/{hibernate,recovery,permissions}.ts` | Sleep policy, failure classification, per-service permission grants |
| `keyboard/keymap.ts` | The one shortcut table: defaults, conflicts, rebinding, per-service passthrough ([#89](decisions.md)) |
| `shell-state.ts` | `projectShellState`, `keyboardMapOf`, `resolveCommand`, `removeServiceFromConfig` |

### `src/main/` — Electron adapters

| Path | Role |
| --- | --- |
| `boot/index.ts` | Entry point: boot order, single-instance lock, IPC surface (commands shape-checked by `core/commands.ts`), quitting |
| `boot/maintenance.ts` | The background loops: session-cookie promotion, the hibernation and endpoint sweeps, suspend and resume |
| `boot/menu.ts` | The application menu, built from the keymap. Owning it is the only way to own ⌘W ([#11](decisions.md)); registering nothing is the only way to rebind it ([#89](decisions.md)) |
| `window/app-window.ts` | Composition root: the window, the rail, panes and `relayout`, `sync`, `dispose`. Builds the pieces below, each with a small host of getters and closures |
| `window/commands/` | Every command's handler, one file per concern (panes, services, workspaces, preferences, data, surfaces), behind a `ShellContext` that lists what a handler may reach. `dispatch` is a lookup |
| `window/attention.ts` | `AttentionCenter`: unread, banners, the Dock badge, push delivery and the recent-notifications list |
| `window/preference-effects.ts` | How a preference reaches outside the config — launchd, proxy, global shortcut, tray, push, ad blocking |
| `window/tile-drag.ts` | Dragging a rail tile onto a pane: frozen geometry, coordinate translation, the drop |
| `window/service-manager.ts` | A `WebContentsView` per service; load, sleep, recover |
| `window/overlay.ts` | Palette and picker layer, attached on demand |
| `window/shortcuts.ts` | `before-input-event` wiring — one listener per contents, keymap read per keystroke |
| `features/` | push-manager, endpoint-poll, sync, drag-layer, find-bar, tray, settings-window, transfer, icons, context-menu. The first three run on timers; `drag-layer` and `find-bar` are attached only for the duration of an interaction |
| `platform/` | config, session, persist-cookies, system, launch-agent, sync-base, ua, quit-state, renderer-url, safe-send, logging, log-file, external, adblock |

### `src/preload/`, `src/renderer/`, `src/shared/`

Smaller, but not implementation details:

| Path | Role |
| --- | --- |
| `preload/sidebar.ts` | The shell's bridge: `getState`, `send`, and the transient subscriptions above |
| `preload/service.ts` | The page's bridge, and deliberately a *different* one — a service must not reach the shell's surface. Notifications, unread rules, the push handshake |
| `renderer/` | React, one bundle, routed by hash: `#rail`, `#overlay`, `#settings`, `#find`, `#drag`, `#empty`. `Settings.tsx` is composition only; each section is its own file in `renderer/settings/` |
| `shared/` | `types.ts`, `catalog.ts`, `keyboard.ts`. Chord parsing lives here rather than in `core` because the renderer needs it and may not import `core` |

### Dependency direction

```
renderer ──preload──▶ main ──▶ core
                                ▲
                      shared ───┘   (types, catalog, chords; imported by all three)
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

Order matters more than usual. Before `whenReady`:

1. `installLogGuards()` — **first**, before anything can log. It mutes `console` after a broken pipe,
   which is what stops a dead terminal killing the app hours later ([#92](decisions.md))
2. `app.setName` — before the menu, or the menu bar reads "Electron"
3. `HANGAR_USER_DATA`, if set, redirects `userData` — this must precede the first `loadConfig()`,
   which happens inside the `AppWindow` constructor
4. **The single-instance lock.** A second copy sharing one profile would fight over cookie jars, so
   it hands off and `exit`s outright rather than calling `app.quit()`, which would not stop the rest
   of the module executing
5. `registerIconScheme()` — must precede app-ready

Then inside `whenReady`:

6. `applyUserAgent()` — first, because it reads `session.defaultSession`, which throws earlier, and
   it must land before any session or view exists
7. `loadConfig()` → `nativeTheme.themeSource` → `installIconProtocol()`
8. `activate` and the IPC surface (`registerIpc()`, one block so it can be read as a list) —
   **before** the window, so a throw while building it cannot leave a Dock icon that does nothing
   and a rail with no `shell:get-state` handler ([decisions #96](decisions.md))
9. `new AppWindow()` → `installMenu()` → `applySystemPreferences()`. Nothing hides the window at
   boot. The menu is given a *getter* for the bindings rather than the bindings themselves, so a
   rebind redraws it without this call site knowing anything about it

Every route to the window — `activate` (Dock, Finder, Spotlight), `second-instance`, the Window and
Dock menus' "Show Hangar" — goes through `ensureShell()`: build an `AppWindow` if there is none,
then `showWindow()`, which re-checks the bounds against the current displays. `Hangar --quit` is the
other half of the single-instance handoff: the running copy quits without its confirm dialog, which
is how `scripts/install-local.mjs` replaces a copy that launchd is supervising.

Then three background loops, in `boot/maintenance.ts`: session-cookie promotion every 60s, the
hibernation sweep every 30s, and the endpoint poll every 30s. Each runs on a timer under `void`, so each catches its own rejection —
otherwise the only symptom of a broken loop is that it silently stopped.

The power hooks are what make those survive a closed lid. `suspend` flushes cookies, because a
closing lid is an unclean exit for anything unwritten. `resume` **credits the suspended time before
anything else**: the sweep 30 seconds later measures idle against a wall clock that has just jumped
by however long the lid was shut, so without it every off-screen service reads as hours idle and gets
unloaded in one go. It then reloads views stale enough to be holding dead sockets.

`before-quit` confirms if asked to and flushes cookies. Every exit path ends in `app.quit()` or
`app.exit(0)` — which is what makes the LaunchAgent's `SuccessfulExit: false` safe
([#93](decisions.md)).

### Running it from a terminal

`npm run dev`, `start` and `icon` all go through [`scripts/run-electron.mjs`](../scripts/run-electron.mjs),
which exists for one reason: it strips an inherited `ELECTRON_RUN_AS_NODE`. Some parent processes set
it — an editor's integrated terminal, for instance — and with it set the Electron binary runs as
plain Node, so the app exits immediately with no window, no error and no output. Its `--profile` flag
points `HANGAR_USER_DATA` elsewhere, which is `dev:isolated`: necessary once the packaged app is
installed, because the single-instance lock is keyed on `userData` and the two would otherwise
collide.

## Diagnostics

Renderer failures are invisible from the terminal, which cost three round trips before these existed:

- **`forwardConsole()`** pipes renderer errors and warnings into the main log, tagged by route.
- **`ErrorBoundary`** wraps every route in `main.tsx`. Without it a render error blanks the surface
  to white with the message only in devtools, which reads as a hang rather than a crash.
- **`ipcMain.on('shell:command')`** wraps dispatch in a try/catch and logs the command name. An
  exception thrown there otherwise surfaces nowhere and looks exactly like a dead button.

There used to be a third: `HANGAR_PROBE=1`, roughly 300 lines in `boot/index.ts` that drove the app
on launch and reported with `console.log`. It found real bugs, but it could only tell a human
something was wrong, and only if they read the output — so it was replaced by Playwright, which can
fail a build ([#72](decisions.md)). The lesson it left behind is still load-bearing in the e2e suite:
`element.click()` proves a handler is wired and nothing else, so only a real input event proves the
view receives input ([#18](decisions.md)).

Removing it also produced its own cautionary entry — the deletion took the background loops with it
and every test stayed green ([#84](decisions.md)).

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
`preferences.ts`, `hibernate.ts` and `logging.ts` are the reference for tone: each explains something
that cost time to learn and would otherwise look like an arbitrary choice ready to be "cleaned up".
