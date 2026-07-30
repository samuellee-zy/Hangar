# Decisions

Findings that cost real time to establish, kept here so they don't have to be rediscovered.
Newest last.

---

## 1. Strip only the Electron token from the user agent

Google blocks sign-in inside detected embedded webviews (`disallowed_useragent`), and Ferdium is
chronically affected ([#1179](https://github.com/ferdium/ferdium-app/issues/1179),
[#2324](https://github.com/ferdium/ferdium-app/issues/2324)) with no maintainer fix.

A teardown of Rambox 2.7.0's `app.asar` showed its entire mitigation is one regex:

```js
ua.replace(/Electron\/([0-9]\.?)+\s/gi, '')
```

It keeps its own app name (`Rambox/2.7.0`) in the string and Google accepts it. A spike
(`spikes/google-login/`) tested seven strategies against Gmail, Calendar, Teams and Salesforce.
**Gmail passed under the plain scrub and under two strictly-more-aggressive variants**, so the scrub
is the load-bearing part.

The untouched Electron UA also passed both headless checkpoints (`accounts.google.com` and the OAuth
authorization endpoint), so Google is not keying on the Electron token at the entry point at all.

**Not needed, having been measured:** stripping the app name, a hardcoded Chrome UA, host-scoped UA
swaps, `Sec-CH-UA` client-hint alignment, or signing in via a separate `BrowserWindow`.
Ferdium's failures are most likely its much older Electron. See `src/main/ua.ts`.

## 2. Rambox has no unread counts, but does run a push stack

The same teardown: 4 references to `favicon`, 3 to `setBadgeCount`, **0 to `unreadCount`**. Badges
come from intercepting `window.Notification` and watching favicon state, not DOM scraping.

It also ships `mcs.proto`, `android_checkin.proto`, `mtalk.google.com` and `vapidKey` — a full
FCM/Web Push receiver. That's how notifications arrive for services whose view is closed, and it's
the answer to "how does Rambox do Slack". Planned as Tier 1.5.

## 3. Session cookies must be promoted, flushed, and promoted on sign-in

Session cookies (no `Expires`) live in memory only, so they die with the process. Chrome papers over
this with "Continue where you left off"; Electron has no equivalent.

Three parts, each learned the hard way:

1. Re-set expiry-less cookies with an explicit one on quit and on a timer.
2. **`ses.cookies.flushStore()` afterwards** — `cookies.set()` only touches the in-memory store, so
   the write can still be pending at exit, which is the exact failure being fixed.
3. **Promote on sign-in detection too** — quitting within the first minute of logging in otherwise
   loses the session silently.

See `src/main/persist-cookies.ts`.

## 4. Salesforce is unfixable at the webview layer

Even with promotion working perfectly — `sid`, `sid_Client`, `clientSrc` and `oid` persisted across
all three Salesforce hosts with a 30-day expiry, 0 rejected, verified on disk seconds after sign-in
— Salesforce still forces a fresh login after restart. It issues `sid` as a session cookie by design
and the org invalidates it server-side on browser close. Chrome behaves identically.

`CatalogEntry.sessionNotPersistable` marks it so we don't extend its cookies pointlessly. The real
answer is a connected app with an OAuth refresh token (Tier 2).

## 5. Google's `/u/<n>/` paths lie when logged out

`mail.google.com/mail/u/0/` and `calendar.google.com/calendar/u/0/r` redirect to Google's
**marketing pages** when there's no session at user index 0 — not to a sign-in page. The service
looks broken rather than logged out.

Always use the bare host. This bit us twice: once for Calendar, then again for Gmail after the
Calendar fix, because the URL had been copied into config at creation time. Which led to:

## 6. Service URLs resolve from the catalog, they aren't copied

`ServiceInstance.url` is an **override only**. Copying the catalog URL into config at creation meant
a catalog fix could never reach an existing install. Resolution happens at load via `resolveUrl()`.

Also: Teams now lands on `teams.cloud.microsoft`, not `teams.microsoft.com`.

## 7. A partition name is the identity of a cookie jar

`Account.partition` is written once at creation and **never derived from anything mutable**. If it
were computed from an id scheme or a label, renaming an account — or changing the scheme, which the
v1→v2 migration does — would silently orphan every session on disk.

The migration reuses the original `persist:grp-*` names verbatim. Verified against the real
partition directories before it was allowed to run. See `src/main/accounts.ts`.

## 8. Panes, not "the active service"

Main owns `panes[]` and `focusedPaneId`; one pane is the degenerate case, not a special case.
Retrofitting split view into a shell hard-wired to a single active view is expensive, so it was
built in from the start even though the first version only ever showed one pane.

Panes are inset as rounded cards (6px gutter, `View.setBorderRadius`) because most web apps have
their own dark left nav — flush against ours, the two read as one confusing double sidebar.

## 9. Identity belongs to the icon, state belongs to the tile

The rail originally tinted each tile with `color-mix(brand 22%)`. Measured against the rail
background that gave Slack **1.03:1** and left Linear and Teams 11 RGB apart — four of six services
were indistinguishable. Brand colour was carrying identity *and* opacity was carrying state, so both
lost.

Now: one neutral surface ramp for state, an edge bar plus the logo for identity. Brand colours are
lifted toward white until they clear 4.5:1 on the tile (`src/renderer/accent.ts`) — Slack goes from
1.07:1 to 4.86:1 and still reads as Slack purple.

## 10. Cross-`webContents` drag is not supported

The rail is one view and each pane is another, so a tile cannot be dragged "into" a pane in the DOM
sense. Reordering within the rail is ordinary DOM drag; dropping onto a pane has to be routed
through the overlay, which draws zones over the pane rectangles main already computes.

## 11. Own the menu or you don't own the keys

Electron installs a default menu when you don't, and its Window submenu binds ⌘W to the `close`
role. That accelerator fires at app level regardless of `before-input-event`, so ⌘W closed the whole
window even when the intent was "close this pane". `src/main/menu.ts` exists primarily to take that
binding back — discoverability is a bonus. The Edit menu's roles are also required for ⌘C/⌘V/⌘A to
work inside the web apps.

## 12. Escape must be bound everywhere, and only swallowed when used

`before-input-event` fires only for the `webContents` that holds focus. Binding Escape to the
overlay alone left a blank overlay unclosable, because the overlay doesn't reliably win focus from a
service view — and a transparent overlay hit-tests across its whole bounds, so the app appeared
frozen.

Escape is now bound on every `webContents`, and the command sink returns whether it acted so the key
is only swallowed when the overlay was actually open. Otherwise Escape would stop working inside
Slack and Gmail.

## 13. Push-only IPC races a view that hasn't loaded

`Overlay.open()` pushed the mode immediately after attaching the view. On the first open the
renderer hadn't subscribed yet, so the message vanished and the overlay rendered nothing while still
swallowing clicks. The renderer now **pulls** on mount and subscribes for later changes.

## 14. Renderer failures are invisible

Three separate bugs this session — blank overlay, dead Escape, inert click — presented identically
as "the UI does nothing", because renderer consoles aren't visible from the terminal and exceptions
in the main-process IPC handler were swallowed. Both are now logged (`forwardConsole`, and a
try/catch around command dispatch). Keep them.

## 15. Rail reordering is ordinary drag; dropping onto a pane is not

dnd-kit handles reordering inside the rail because the rail is a single `webContents`. Two details
worth keeping: a `PointerSensor` distance constraint of 5px, without which every click registers as
a zero-length drag and tiles stop responding to plain clicks; and the `KeyboardSensor`, which is
most of the justification for the dependency — space to lift, arrows to move, announced to screen
readers, none of which we'd have written by hand.

Dropping a tile **onto a pane** still isn't built. It can't use the same mechanism (decisions #10)
and needs the overlay to run in a third "drag" mode, drawing zones over the pane rectangles main
already computes.

## 16. Clicking an already-added service must not silently duplicate it

The picker originally always added. Clicking Gmail when you already had Gmail produced a second
instance on the same account showing the same mailbox — functionally correct, visually identical to
nothing happening, and reported as "the + button doesn't work".

Services already present now show "✓ added" and clicking focuses the existing one. "+ another
account" remains for a genuinely separate login. **Feedback matters more than correctness here: an
action whose result is invisible reads as a broken button.**

## 17. Broadcast to every surface, not just the one you were looking at

`sync()` sent `shell:state` to the rail only. Three surfaces render shell state — rail, overlay,
Settings — so two silently displayed whatever they fetched on mount. Reopening the connection picker
showed the service list from the first open of the session: stale "✓ added" flags, stale ids.

Compounding it, `OverlayRoot` keyed on `mode`, so reopening in the same mode didn't remount.

Fixed structurally: `AppWindow.registerConsumer()` plus a `broadcast()` that fans out to all of
them, and an open-nonce in the mode message so every open remounts. Settings' private
`settings:state`/`settings:command` channel is gone — a second channel is what let it drift.

## 18. An action with an invisible outcome is indistinguishable from a broken button

Reported as "I can't click on any of the connectors". Real mouse events were arriving fine —
verified with `sendInputEvent` at the tile's actual coordinates, which is what `element.click()`
could never prove because it bypasses hit-testing.

The truth: 6 of 9 tiles were already-added services, whose click focuses a pane that is usually
*already* focused. `Layout.show()` set the same value, the overlay closed, nothing moved.

Every action now flashes the target rail tile (`ShellState.flashServiceId`). **Diagnostic lesson:
`element.click()` proves a handler is wired and nothing else. Use `sendInputEvent` when the question
is whether input reaches the view.**

## 19. Never derive a "registrable domain" by taking the last two labels

`host.split('.').slice(-2)` turned `foo.example.co.uk` into `co.uk` — an allowlist entry that let
**every** `.co.uk` site navigate inside the app. Same for `.com.au`, `.co.jp` and the rest.

Custom connections now allowlist the exact host; `isAllowedHost` already matches subdomains via a
leading-dot suffix check, so nothing is lost.

## 20. Preferences validate against their defaults, and defaults are never handed out by reference

`set-preference` carries an arbitrary path and value across IPC — the one command where a malformed
renderer message could corrupt config on disk. It validates against `DEFAULT_PREFERENCES`: unknown
paths, type mismatches, non-nullable nulls and array/scalar swaps are all rejected.

Two bugs the tests caught before anyone saw them:

- `withDefaults(undefined)` returned `DEFAULT_PREFERENCES` **by reference**, so the first preference
  change permanently mutated the defaults for the whole process.
- Writing to a *branch* was accepted — `set-preference appearance {…}` replaced a whole section and
  skipped every per-key check, because object-vs-object satisfies a naive `typeof` comparison.

## 21. Rail placement is constrained by the traffic lights, not the layout maths

Generalising `Layout` to four edges was easy; the window buttons were not. They span 52pt and have
to live somewhere:

- **left** — inside the rail, centred.
- **top** — inset at the rail's left end, reading as a toolbar.
- **right / bottom** — the rail is nowhere near the top-left, so a 38px chrome strip is reserved.

`setWindowButtonPosition()` moves them at runtime, so changing position doesn't recreate the window
— which `titleBarStyle` would otherwise have forced.

## 22. Hibernation's dangerous failure is unloading something visible

Wasting memory is a nuisance; unloading a pane someone is typing into is data loss. The decision is
a pure function (`hibernate.ts`) so it can be tested exhaustively, and "never sleep a visible
service" is pinned hardest. `powerMonitor` covers the other half: a closing lid is an unclean exit
as far as unwritten session cookies go, and views that slept through it hold a dead socket.

## 23. Close-to-tray needs to know a real quit from a window close

Intercepting the window's close event to hide instead would swallow ⌘Q too. `quit-state.ts` holds
the flag, in its own module so `window.ts` needn't import `index.ts` and create a cycle.

## 24. Export excludes sessions, and says so

Partitions aren't portable, so an export that looked like a full backup while silently dropping
every login would be worse than no export. The file carries a `_note` saying so, and the import
dialog repeats it.

## 25. dnd-kit's keyboard sensor shadows plain activation

Its listeners bind Space/Enter to "lift", and on the tile itself that means a keyboard user can
never simply open a service. Pointer listeners stay on the tile; keyboard dragging moved behind
⌃Space.

## 26. Config migrations are cumulative and save immediately

Four versions so far: v1 → v2 (accounts), v3 (preferences), v4 (folder tree). Each migration runs on
load and `saveConfig` fires straight afterwards, so an upgrade is durable even if the app is killed
seconds later.

Two rules that keep this cheap:

- **Additive changes need no migration at all.** Preferences merge onto defaults, so a new key is
  simply present.
- **Structural changes get a version.** `Workspace.serviceIds` → `RailItem[]` couldn't be inferred
  from the data, so v4 exists and `migrateWorkspaceV3` is a no-op on already-migrated input.

A gotcha worth knowing when editing config by hand: the app writes its **in-memory cache** on quit,
so an external edit while it's running is overwritten. Stop the app first.

## 27. Keep the decision modules free of Electron

`layout`, `accounts`, `folders`, `preferences` and `hibernate` import nothing from Electron. That's
not aesthetic — it's what lets `npm run check` bundle each with esbuild and exercise it under plain
node in milliseconds, with no window and no display.

Everything genuinely worth testing in this app is a decision: which panes go where, which service
sleeps, which partition a service uses, whether a preference is valid. Keeping those separable from
the Electron surface is why there are 81 checks rather than none.

A stray `import { app }` costs a whole suite, so `config.ts` — which needs exactly one path lookup —
is tested via an Electron stub (`scripts/electron-stub.mjs`) instead.

## 28. Config writes are atomic, and a corrupt config is never overwritten

The worst bug found in the whole project, and it was in code written for this app rather than
inherited. `saveConfig` was a plain `writeFileSync`, and `loadConfig` responded to a parse failure
by writing defaults **straight over the file**.

The chain: crash or power loss mid-write → truncated JSON → next launch destroys every service,
account, folder and preference, and orphans every partition on disk. Config is written on every
preference change, every layout change and a 400ms window-bounds debounce, so the exposure was real.

`config-store.ts` now guarantees three things, each with tests:

1. **Atomic writes** — temp file plus rename, which is atomic within a filesystem. The temp file
   lives in the same directory deliberately; a temp dir can be on another volume, where rename
   isn't atomic.
2. **A corrupt file is never overwritten** — it's moved to `config.json.corrupt-<ts>`. Quarantine
   names are de-duplicated, because `Date.now()` is millisecond-resolution and two failures in one
   tick would otherwise destroy the earlier bad copy — the exact thing quarantine exists to prevent.
3. **A rolling backup** rotates before each write, so recovery doesn't depend on the user having
   exported.

Also: parseable-but-empty is treated as corrupt. `{}` is valid JSON and accepting it would silently
replace a real config with nothing.

Verified end to end: truncating a live 7-service config and relaunching now recovers all 7 from
backup and leaves the bad copy for inspection.

## 29. Preference effects dispatch per key, not wholesale

`applySystemPreferences()` ran on *every* `set-preference`, so changing the rail size re-registered
the global shortcut, re-ran `setLoginItemSettings` and kicked off an unawaited proxy fan-out across
every session. Now only the changed key's effect runs. The full pass remains, for boot.

Two related fixes in the same area:

- **Proxy is applied in `sessionFor()`**, not only in the bulk pass. Hibernation destroys and
  recreates views, so a proxy set once silently stopped applying to anything woken afterwards.
- **`spellcheckLanguages` re-applies to live sessions**; it's read once per session at creation.

## 30. The tray needed its own preference and a symmetric lifecycle

`ensureTray` was only called when `closeToTray || startHidden`, so wanting a menu-bar presence meant
enabling an unrelated setting — and `destroyTray` existed but was never called, so the icon outlived
whatever turned it on. There's now an `appearance.showTrayIcon` preference, and `closeToTray` still
forces a tray on, because hiding the window with no icon leaves no way back to it.

## 31. `contextIsolation` means the preload's `window` is not the page's `window`

The single most costly misunderstanding in the codebase, and it was silent. With
`contextIsolation: true` the preload runs in an *isolated world* with its own `window`. Patching
`window.Notification` there does nothing the page can see.

Three patches were affected and all three were no-ops for as long as they existed: the Notification
override, the `navigator.setAppBadge` stub, and the credentials-prompt block. Nothing errored;
they simply had no effect, and the notification path looked plausible while counting nothing.

The split now:

- **isolated world** (`preload/service.ts` top level) — owns `ipcRenderer`, exposes a narrow
  `__hangar` bridge via `contextBridge.exposeInMainWorld`;
- **main world** — receives the actual patches through `contextBridge.executeInMainWorld`, reaching
  back through that bridge.

The main-world function is *serialised*, so it cannot close over anything in the preload file.
Everything it needs comes through the bridge or is defined inline — which is why the notification
class is declared there rather than imported.

`executeInMainWorld` is still marked experimental. The call is wrapped, and failure logs loudly
rather than silently degrading, because a silent degrade is exactly what this replaces.

**How it was caught:** a runtime probe that fires a real `new Notification()` inside a background
service and checks the count moves. Type-checking and reading the code both said it was fine.

## 32. Notification policy: suppressing a banner is not ignoring the event

Do Not Disturb hides the interruption but **still counts** the message, so a focus session doesn't
end with a badge of zero and no idea what happened. Muting a service is the opposite — you asked not
to care, so it neither banners nor counts. A visible service does neither either: there's nothing
unread about a pane you're looking at.

Unread is cleared by *looking* at a service, not by dismissing a banner — matching how the
underlying web apps behave, and the only signal we reliably have.

## 33. Deleting a workspace must not strand its services

Services live in one global list; a workspace only *references* them. Delete a workspace and any
service referenced by nothing else becomes unreachable — still in config, still holding a live
session and a partition on disk, invisible in every rail. Silent data loss with extra steps.

Deletion therefore **rehomes orphans** into the first surviving workspace, and the last workspace
can't be deleted at all. Same reasoning as ungrouping a folder: removing a grouping should never
remove the things grouped.

`rehomeUnreachable()` runs at boot as a safety net, so a config that got into that state some other
way repairs itself rather than quietly hiding services.

Before this, workspaces were **dead UI**: switchable via ⌘⌥1…9 and listed in the palette, but with
no way to create one, so there was only ever the default.

## 34. Failure handling must not over-react

`did-fail-load` fires far more often than anything is actually broken, and an error page shown over
a working service is worse than no error handling at all. Two filters do most of the work:

- **`ERR_ABORTED` (-3) is not a failure.** It fires whenever a navigation is superseded — a
  redirect, a click during load, an SPA replacing a pending request. Treating it as an error makes
  Gmail flash an error page during ordinary use.
- **Subframe failures are not page failures.** A third-party widget dying is routine; only
  `isMainFrame` counts.

Genuinely transient codes retry with backoff (1s/2s/4s, capped at 3) rather than showing anything;
a successful load clears the counter so an outage earlier in the session doesn't make the next blip
give up immediately. Non-transient codes show the error page straight away — retrying a 404 is
pointless.

For crashes, `clean-exit` is excluded: we close those views ourselves for hibernation and pane
close, and reloading them would defeat hibernation entirely.

The error page is served as a data URL into the failed view, so it inherits the service's preload
and can call `__hangar.retry()` — no extra window, no extra route. All interpolated values are
escaped; a service name is user-controlled.

## 35. Editing config.json while the app runs loses data — including when *I* do it

Decision #26 records that the app writes its in-memory cache on quit, so external edits are
overwritten. During Phase 3 I did exactly that anyway, with `python` cleanup scripts run against a
live app, and lost two services from config — Notion and Linear.

Worth recording for two reasons:

1. **The recovery worked.** Their partitions (`grp-notion`, `grp-linear`) were untouched on disk, so
   rebuilding the accounts pointing at those exact partition names brought the sessions back with
   no re-authentication. This is the payoff of decision #7: partition names are stable identifiers,
   not derived values, so a config can be reconstructed around them.
2. **It was not a bug in the app.** Verified by launching and quitting three times and confirming
   the service count held. Worth checking before assuming — the same symptom would be alarming if
   it *were* the app.

Stop the app before touching `config.json`.

## 36. Permissions follow provenance, and deny by default

Every service used to get an identical grant — notifications, media, clipboard read, sanitized
write, fullscreen — which meant a **custom connection to an arbitrary URL could take the microphone
and camera on request, with no prompt.** The catalog is curated; "add any website by URL" is not.

Two principles in `permissions.ts`:

- **Deny by default.** Anything not on the allowlist is refused, so a permission type Electron adds
  later (HID, serial, USB, idle detection) arrives denied rather than silently granted.
- **Trust follows provenance.** Baseline for everyone: notifications, fullscreen, sanitized
  clipboard *write*, pointer lock — none of which reach hardware or read silently. Curated services
  additionally get media, clipboard read and screen share. A custom connection gets those only via a
  per-service `allowMedia` toggle.

`setPermissionCheckHandler` is set alongside `setPermissionRequestHandler`. Leaving the check
handler at its default would let a synchronous query bypass the request handler entirely.

Service views now also run **`sandbox: true`**, which was verified rather than assumed: the
notification path is the most demanding consumer of the preload, and the runtime probe still reports
`unread 0 → 1` under sandboxing.

## 37. Orphaned partitions are reported, never auto-deleted

Removing a connection leaves its partition on disk — deliberately, so re-adding it doesn't mean
signing in again. But they accumulate: four were sitting unreferenced by the time this was written.

Settings surfaces the count with a Delete button. **Not automatic, and not at boot.** These are
cookie jars; a bug in the reachability calculation would silently sign the user out of everything,
and doing that unprompted at startup is exactly the class of mistake already made once with config
(decision #28). The scan runs at boot and after a purge — there's no reason to stat the disk on
every sync.

## 38. Find in page can't use the overlay layer

The overlay is a full-window transparent view, and a transparent `WebContentsView` hit-tests across
its whole bounds. Using it for find would block clicking and scrolling **the page you're searching**
— the one interaction find has to leave working.

So the find bar is its own view, sized to the bar (340×46) and parked in the top-right of the
*focused pane*, so it follows a split rather than the window. Only that rectangle intercepts clicks.

`findInPage` is per-`webContents`, which suits panes exactly: a search targets the focused pane and
nothing else. Closing uses `stopFindInPage('keepSelection')`, so dismissing the bar and then copying
behaves the way a browser does. An empty query calls `stopFindInPage` rather than `findInPage`,
which would throw.

## 39. Zoom is persisted per service and ⌘0 resets to the preference

⌘+/− adjust the focused service and write the value to config, so it survives a reload and a
restart. ⌘0 resets to `behaviour.defaultZoom` rather than a hardcoded 1 — someone who set a default
of 1.2 because of their display means it, and snapping to 1 would fight them every time.

## 40. Web Push needs a Firebase project we can't ship

FCM web registration goes through `firebaseinstallations.googleapis.com`, which requires `apiKey`,
`appId` and `projectId`. Google decommissioned the sender-id-only subscribe path, so there is no
anonymous registration any more — this was checked in the library source, not assumed.

Hangar can't embed a project: the key would be in the repo, on one quota, revocable for everyone by
any single user's abuse. Rambox can, because Rambox is a company. So the credentials are
**user-supplied** and the feature is off until they're filled in. Free tier, ~3 minutes, and the
setup is in [push.md](push.md).

The honest consequence: this is the one feature in Hangar with a setup step, and it stays off for
anyone who doesn't want one.

## 41. Push failures resolve to null, never reject

`subscribePush` returns `null` when push is off, unconfigured, or registration failed, and the
patched `subscribe` then calls the browser's original. A rejection would break the site's own
notification setup outright.

The rule: intercepting a site's API means a failure on our side must leave it exactly as it was
without us — never worse.

## 42. One socket per service, and it can't be otherwise

A registration is bound to the VAPID key it was created with; FCM rejects a push signed by a key
that doesn't match the subscription. So registrations can't be pooled, and N push-enabled services
means N connections to `mtalk.google.com`. That cost is why push is opt-in per service.

It's also why `upsertRegistration` replaces by service id rather than by `(service, key)`: a site
rotating its application server key must *evict* the dead registration, not accumulate beside it.

## 43. `isDestroyed()` is not enough before `send`

A renderer that has crashed reports `isDestroyed() === false` while its render frame is already
gone, and `send` then throws "Render frame was disposed". One crash makes every consumer throw at
once — and that volume of noise is exactly what buried three separate bugs earlier in this project.
`safeSend` checks *and* catches.

## 44. Electron rasterizes the app icon

A stock Mac has no rsvg, ImageMagick or Inkscape, and adding a build dependency to draw one icon
isn't worth it — Chromium is already here. `scripts/make-icon.mjs` renders an inline SVG and
`iconutil` packs it, so the icon stays diffable instead of being a committed binary.

Two failures found doing it, both surfacing as a bare `ERR_FAILED (-2)` with nothing else to go on:
a `data:` URL past Chromium's length limit, and a *second* offscreen window. It now renders once at
1024 from a temp file and downscales — which also guarantees all ten sizes are the same artwork.

## 45. Launch at login needs a signature, and has to be verified by reading back

macOS registers login items against a code signature. Unsigned, it refuses with "Operation not
permitted" — logged by Chromium's native layer, so `setLoginItemSettings` **never throws** and a
naive call looks like it worked.

`applyLoginItem` now reads the setting back and returns whether it took. A toggle the user flips
that quietly does nothing is worse than one that admits it can't.

## 46. Info.plist usage strings are not boilerplate

macOS kills the app outright, with no dialog, if a permission is requested without a usage string.
Catalog services can be granted microphone and camera, so without `NSMicrophoneUsageDescription`
the first Slack huddle terminates Hangar.

## 47. An empty config is not a corrupt config

`loadConfig`'s guard rejected `services: []`, and `readWithRecovery` treats a rejected parse as
corruption — so it quarantined the file and fell back to the backup.

But `services: []` is a state the app *itself writes*: removing your last service produces it, and
there's an `EmptyState` view built for that case. The guard made a legitimate config
indistinguishable from a truncated one.

The full path: remove your last service → the next window move rotates the now-empty config into the
backup → restart → main quarantined, backup also rejected → `defaultConfig()` writes six new
services on six new partitions over everything. Every account-to-partition mapping gone; the real
setup surviving only in a `.corrupt-*` file nobody was ever told about.

Verified end to end against a staged config: before, accounts were replaced; after, all seven
survive and no quarantine file is created.

The rule: **validate structure, not emptiness.** An absent `services` key is corruption. An empty
one is a Tuesday.

## 48. Quarantined copies have to be surfaced

Nothing ever mentioned a `.corrupt-*` file again after the boot that created it. Since these exist
precisely when the user's setup could not be loaded, they're the one thing worth pointing at.
`findQuarantined` lists them, boot logs them, and Settings shows a "Recovered configuration" section
with a Show in Finder button — rendered only when there's something to show.

Never deleted automatically: a file that exists because recovery failed shouldn't be cleaned up by
the same code that failed. `reveal-path` is restricted to paths we surfaced, since an arbitrary path
over IPC would be a way to probe the disk.

## 49. Two bugs that produced invalid CSS, not wrong colours

`brightenForDark` assumed `#RRGGBB` and indexed blindly:

```
brightenForDark('hsl(147 55% 55%)')  →  '#NaNNaN14'   — every custom connection
brightenForDark('#666')              →  '#6606NaN'    — the state() fallback
```

`colorForHost` emits `hsl(…)` for every custom connection, and `'#666'` is hardcoded in `state()`,
so both were live on every launch. Nothing complained: `parseInt('hs', 16)` is `NaN`, `NaN < 4.5` is
`false` so the contrast loop never ran, and the browser silently discarded the malformed
`--accent`. The tile just looked plain.

Now `parse` returns null for anything it can't read and the caller **returns the input unchanged**.
An `hsl()` string is valid CSS, so the tile keeps its colour — it just doesn't get the contrast
lift. Failing open beats emitting a value the browser will throw away.

The general lesson: a function that produces a *string* consumed by a lenient parser has no failure
mode. CSS, URLs and shell arguments all swallow garbage silently, so the validation has to be ours.

## 50. Vitest, and why the migration came before the restructure

The hand-rolled harness worked, but `package.json` hardcoded 13 `esbuild src/main/<file>.ts` paths —
one per suite. Moving any file into `src/core/` would have broken all 13 at once, so the plan's
claim that "the existing checks stay green throughout and are the safety net" was false: they'd have
been *offline for the entire restructure*.

Vitest resolves through `tsconfig`, so it survives the moves. Hence tests first, restructure second.

The port was a codemod, not a rewrite — `ok()` → `it()`, `console.log(section)` → `describe`, and
`node:assert/strict` kept as-is. Rewriting ~289 assertions into `expect()` at the same time would
have meant that if the suite went red, there'd be no way to tell which change did it. 168 tests in,
168 tests out.

Electron is aliased to the existing stub rather than `vi.mock`'d, for the same reason: the stub is
already proven against this code.

## 51. A missing persistentId turned deduplication off

`persistentId` is typed as a string but arrives from the wire, and FCM doesn't guarantee it. An
`undefined` was pushed into `seen`, so a run of them filled the 512-entry cap and evicted the real
ids the list exists to remember.

Now a falsy id delivers the message — it's still a message — without recording it. We can't
recognise it again, and pretending otherwise costs us the ones we can.

## 52. Feature-sliced modules, with the boundary enforced rather than intended

`src/main/` was 24 files in one flat directory: 14 pure, 18 importing Electron, and nothing marking
which was which. The "pure module" discipline that makes this codebase testable was a convention
held by hand — nothing stopped a pure module gaining `import { app } from 'electron'`, and it would
only have been noticed if that module happened to have a test.

Now `src/core/` is the pure domain and `src/main/` the Electron adapters, grouped by role
(`boot`, `window`, `features`, `platform`). `dependency-cruiser` runs in `npm run check` and fails
the build on `core → electron`, `core → react`, `core → main`, `renderer → main`, and cycles.

That's also what keeps the core genuinely extractable. A single package is right today, but if
`core/` ever needs to become one, the work is a `git mv` plus a manifest **provided the boundary
actually held** — which is now proven continuously rather than discovered to be false on the day it
matters.

## 53. A boundary rule that never fires is worse than no rule

Three of the five rules were misconfigured and silently passed. `to: { path: '^electron$' }` never
matches, because what the dependency graph holds is the *resolved* path
`node_modules/electron/index.js`. Same for `^(react|react-dom)`. And `electron` is an `npm-dev`
dependency, not `npm`, so a `dependencyTypes: ['npm']` filter excluded it too.

All three reported a clean graph. Nothing was wrong with the code — the rules just weren't looking
at anything.

Found by **deliberately adding a violation and checking the rule caught it.** Every rule here has
been verified that way. A green boundary check reads as proof, so it has to actually be one; the
same reasoning as the isolated-world bug in #31, where code that typechecked and reviewed clean was
a silent no-op.

`tsConfig` must also be passed in options, or every `@core/*` alias misresolves and the rules cruise
a graph that isn't the real one.

## 54. `dispose()` hooks `closed`, not `close`

⌘W on the last pane destroys the window, and the dock icon builds a whole new `AppWindow` — while
nothing disposed the old one. Everything system-level kept a closure over the dead window:

- the global shortcut threw `Object has been destroyed` from then on, permanently
- `ensureTray` and `openSettingsWindow` both early-return on their existing instance, so both kept
  dispatching into the old window; Settings rendered a frozen snapshot
- the old `PushManager` kept its sockets, so a second set opened alongside — every notification
  twice, each click calling `showWindow()` on a destroyed window
- service views detached with `removeChildView` aren't children of the window, so they aren't
  destroyed with it. ~100 MB each, still resident, still running reload timers

`applySystemPreferences()` was called once at boot and never on `activate`, which is why none of it
recovered.

**`closed`, not `close`** — the close handler calls `preventDefault()` when `closeToTray` is on, so
`close` also fires for a window the user merely hid. Disposing there would destroy a window the
tray icon still points at.

Verified: after close, `shell` is null and the views are destroyed; after `activate`, `show-window`
and `open-settings` both succeed where they previously threw.

## 55. Cookie promotion must finish before anything is disposed

`persistAll()` on quit promotes session cookies to persistent ones — the entire reason a restart
doesn't sign you out. Tearing down sessions or views before it resolves loses that, which is the
exact failure Phase 1 was built to prevent, reintroduced by the fix for #54.

So the quit path awaits it, and now logs a failure instead of dropping it into an unhandled
rejection.
