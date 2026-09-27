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
ua.replace(/Electron\/([0-9]\.?)+\s/gi, "");
```

It keeps its own app name (`Rambox/2.7.0`) in the string and Google accepts it. A spike
(`spikes/google-login/`) tested seven strategies against Gmail, Calendar, Teams and Salesforce.
**Gmail passed under the plain scrub and under two strictly-more-aggressive variants**, so the scrub
is the load-bearing part.

The untouched Electron UA also passed both headless checkpoints (`accounts.google.com` and the OAuth
authorization endpoint), so Google is not keying on the Electron token at the entry point at all.

**Not needed, having been measured:** stripping the app name, a hardcoded Chrome UA, host-scoped UA
swaps, `Sec-CH-UA` client-hint alignment, or signing in via a separate `BrowserWindow`.
Ferdium's failures are most likely its much older Electron. See `src/main/platform/ua.ts`.

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

See `src/main/platform/persist-cookies.ts`.

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
partition directories before it was allowed to run. See `src/core/services/accounts.ts`.

## 8. Panes, not "the active service"

Main owns `panes[]` and `focusedPaneId`; one pane is the degenerate case, not a special case.
Retrofitting split view into a shell hard-wired to a single active view is expensive, so it was
built in from the start even though the first version only ever showed one pane.

Panes are inset as rounded cards (6px gutter, `View.setBorderRadius`) because most web apps have
their own dark left nav — flush against ours, the two read as one confusing double sidebar.

## 9. Identity belongs to the icon, state belongs to the tile

The rail originally tinted each tile with `color-mix(brand 22%)`. Measured against the rail
background that gave Slack **1.03:1** and left Linear and Teams 11 RGB apart — four of six services
were indistinguishable. Brand colour was carrying identity _and_ opacity was carrying state, so both
lost.

Now: one neutral surface ramp for state, an edge bar plus the logo for identity. Brand colours are
lifted toward white until they clear 4.5:1 on the tile (`src/renderer/accent.ts`) — Slack goes from
1.07:1 to 4.86:1 and still reads as Slack purple.

## 10. Cross-`webContents` drag is not supported

The rail is one view and each pane is another, so a tile cannot be dragged "into" a pane in the DOM
sense. Reordering within the rail is ordinary DOM drag; dropping onto a pane has to be routed
through a separate surface, drawing zones over the pane rectangles main already computes.

**Superseded in part by entry 86.** The claim above is still true, and it is still the reason the
obvious implementation doesn't exist. What it got wrong was the conclusion: the drag doesn't have to
cross the boundary if no renderer is deciding anything.

## 11. Own the menu or you don't own the keys

Electron installs a default menu when you don't, and its Window submenu binds ⌘W to the `close`
role. That accelerator fires at app level regardless of `before-input-event`, so ⌘W closed the whole
window even when the intent was "close this pane". `src/main/boot/menu.ts` exists primarily to take that
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

Filing into a folder is the same drag: an open folder's members are rows of the same
`SortableContext` as the top level, so one gesture covers reorder, file in, and take out. What the
drop _means_ is decided in `moveItemTo` from what was dropped on rather than from where it landed in
the flattened order — see entry 87 for why the index alone can't answer it.

Dropping a tile **onto a pane** cannot use the same mechanism (decisions #10). It is built now, on a
dedicated drag layer rather than the overlay — see entry 86.

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
_already_ focused. `Layout.show()` set the same value, the overlay closed, nothing moved.

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
- Writing to a _branch_ was accepted — `set-preference appearance {…}` replaced a whole section and
  skipped every per-key check, because object-vs-object satisfies a naive `typeof` comparison.

## 21. Rail placement is constrained by the traffic lights, not the layout maths

Generalising `Layout` to four edges was easy; the window buttons were not. They span 52pt and have
to live somewhere:

- **left** — inside the rail, centred.
- **top** — inset at the rail's left end, reading as a toolbar. Compact too; see #102.
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
the flag, in its own module so `app-window.ts` needn't import `index.ts` and create a cycle.

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

`store.ts` now guarantees three things, each with tests:

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

`applySystemPreferences()` ran on _every_ `set-preference`, so changing the rail size re-registered
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
`contextIsolation: true` the preload runs in an _isolated world_ with its own `window`. Patching
`window.Notification` there does nothing the page can see.

Three patches were affected and all three were no-ops for as long as they existed: the Notification
override, the `navigator.setAppBadge` stub, and the credentials-prompt block. Nothing errored;
they simply had no effect, and the notification path looked plausible while counting nothing.

The split now:

- **isolated world** (`preload/service.ts` top level) — owns `ipcRenderer`, exposes a narrow
  `__hangar` bridge via `contextBridge.exposeInMainWorld`;
- **main world** — receives the actual patches through `contextBridge.executeInMainWorld`, reaching
  back through that bridge.

The main-world function is _serialised_, so it cannot close over anything in the preload file.
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

Unread is cleared by _looking_ at a service, not by dismissing a banner — matching how the
underlying web apps behave, and the only signal we reliably have.

## 33. Deleting a workspace must not strand its services

Services live in one global list; a workspace only _references_ them. Delete a workspace and any
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

## 35. Editing config.json while the app runs loses data — including when _I_ do it

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
   it _were_ the app.

Stop the app before touching `config.json`.

## 36. Permissions follow provenance, and deny by default

Every service used to get an identical grant — notifications, media, clipboard read, sanitized
write, fullscreen — which meant a **custom connection to an arbitrary URL could take the microphone
and camera on request, with no prompt.** The catalog is curated; "add any website by URL" is not.

Two principles in `permissions.ts`:

- **Deny by default.** Anything not on the allowlist is refused, so a permission type Electron adds
  later (HID, serial, USB, idle detection) arrives denied rather than silently granted.
- **Trust follows provenance.** Baseline for everyone: notifications, fullscreen, sanitized
  clipboard _write_, pointer lock — none of which reach hardware or read silently. Curated services
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
_focused pane_, so it follows a split rather than the window. Only that rectangle intercepts clicks.

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
rotating its application server key must _evict_ the dead registration, not accumulate beside it.

## 43. `isDestroyed()` is not enough before `send`

A renderer that has crashed reports `isDestroyed() === false` while its render frame is already
gone, and `send` then throws "Render frame was disposed". One crash makes every consumer throw at
once — and that volume of noise is exactly what buried three separate bugs earlier in this project.
`safeSend` checks _and_ catches.

## 44. Electron rasterizes the app icon

A stock Mac has no rsvg, ImageMagick or Inkscape, and adding a build dependency to draw one icon
isn't worth it — Chromium is already here. `scripts/make-icon.mjs` renders an inline SVG and
`iconutil` packs it, so the icon stays diffable instead of being a committed binary.

Two failures found doing it, both surfacing as a bare `ERR_FAILED (-2)` with nothing else to go on:
a `data:` URL past Chromium's length limit, and a _second_ offscreen window. It now renders once at
1024 from a temp file and downscales — which also guarantees all ten sizes are the same artwork.

## 45. Launch at login needs a signature, and has to be verified by reading back

> **Superseded in part by [#93](#93-a-launchagent-gets-launch-at-login-without-a-signature).** The
> diagnosis holds — `setLoginItemSettings` really is refused unsigned — but the conclusion that the
> feature therefore needs a Developer ID does not. It needs a different mechanism. The read-back
> discipline below survived the change and is still how the toggle reports success.

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

But `services: []` is a state the app _itself writes_: removing your last service produces it, and
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

The general lesson: a function that produces a _string_ consumed by a lenient parser has no failure
mode. CSS, URLs and shell arguments all swallow garbage silently, so the validation has to be ours.

## 50. Vitest, and why the migration came before the restructure

The hand-rolled harness worked, but `package.json` hardcoded 13 `esbuild src/main/<file>.ts` paths —
one per suite. Moving any file into `src/core/` would have broken all 13 at once, so the plan's
claim that "the existing checks stay green throughout and are the safety net" was false: they'd have
been _offline for the entire restructure_.

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
matches, because what the dependency graph holds is the _resolved_ path
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

## 56. Unread outlives the view, which is what makes Web Push work

`unread` was a field on `ServiceRuntime` — the object holding a service's live `WebContentsView`.
That tied the count to the view's lifetime, and broke two things:

**Hibernation wiped the count.** `sleep()` destroys the runtime, so "3 unread in Slack" evaporated
the moment Slack idled out. Badge, tray and folder roll-up all reset with no user action.

**Web Push was dropped entirely.** `handleNotification` opened with
`if (!svc || !runtime) return;` — and a hibernated service has no runtime _by definition_. Every
push for a sleeping service was decrypted, deduplicated, its `persistentId` persisted so it would
never replay, and then discarded. Silently. The entire premise of Phase 3.6 — that hibernating a
service shouldn't mean going silent on it — was false for its whole existence.

Counts now live in `core/notify/unread.ts`, keyed by service id. Not persisted: a restart
legitimately starts from zero, and persisting would mean a disk write per notification. Pruned on
service removal, or the badge counts something the user deleted.

## 57. Verifying A1 needed no Firebase at all

Phase 3.6 was verified as far as "subscribe is intercepted", which it was. Delivery was left because
it looked like it required a Firebase project and a real inbound message — so the broken half went
untested and shipped.

It never needed either. `handlePushMessage` receives an _already decrypted_ payload, so injecting a
synthetic one exercises everything downstream of decryption, which is precisely where the bug lived.
`PushDeps.deliver` was already an injected seam.

The lesson is about where a verification boundary gets drawn. "Needs external setup" was true of the
transport and false of the logic, and treating them as one thing is what let a non-functioning
feature ship as done.

## 58. Import must go through the same normalisation as load

`importConfig` did `saveConfig({ ...(parsed as Config) })` — no `withDefaults`, no migration, no
version handling. The only validation was that `services` and `workspaces` were arrays.

Importing a v3-era export therefore wrote a structurally invalid config straight to disk: missing
`preferences` threw in `sessionFor`, workspaces without `items` threw in `flattenServiceIds`, and
missing `accounts` threw in `partitionFor` on every service open _and_ inside the 60-second
`persistAll` loop, killing session durability. All under a floating `void importConfig(...)`, so it
surfaced as an unhandled rejection with the window half-rebuilt and the bad file already saved.

`migrateConfig` is now a single pure function both paths call. It also backfills `zoom`,
`hibernate` and `notifications`, which are typed required but were never filled in for older
configs — `hibernate: undefined` is falsy so the service silently never slept, and
`zoom: undefined` reached `setZoomFactor` and threw out of the `AppWindow` constructor, so the app
failed to render at all on the first launch after upgrading.

## 59. Refusing to migrate is sometimes the safe answer

The old branch was `(parsed.version ?? 0) >= 2 && parsed.accounts ? … : migrateV1(parsed)`. A v4
config that had _lost_ its accounts array fell through to `migrateV1`, which regenerates partitions
from `sessionGroup ?? catalogId`. For a v4 config neither field is what that code expects, so the
generated names don't match the directories on disk and **every service loses its cookie jar**.

`migrateConfig` now throws on that input. The caller keeps the original file and starts from
defaults, so the user can be signed out _recoverably_ rather than silently and permanently. A
migration that can't be sure is better off refusing than guessing at cookie-jar identity.

## 60. Retargeting a pane has to open what it points at

`sleep()` and `removeService` both pointed an orphaned pane at "the first other service in the
workspace" — and stopped there. Nothing loaded it, so the pane had no view, `hasVisibleContent` was
false, and the **empty state appeared with a full rail**. The replacement also wasn't checked
against panes already on screen, so a split could render the same service twice, and neither path
saved the layout, so config kept naming the service that had just gone.

One `retargetPane` now handles both: prefer a service not already visible, load it, and if there's
genuinely nothing left, drop the pane so the empty state is _correct_ rather than accidental.

## 61. The find bar closes when focus moves

`target` was set once on open, while `relayout` moved the bar to follow the focused pane — so it sat
over one pane and searched another. Closing on divergence is the honest answer; silently retargeting
a search someone is halfway through is worse than making them press ⌘F again.

## 62. `rename` is atomic; the bytes underneath it are not

`writeAtomic` wrote the temp file and renamed. Rename is atomic with respect to _ordering_, but
without an `fsync` the contents can still be in the page cache — so a power loss can leave a
correctly-named file full of zeroes. Which is precisely the failure this module exists to prevent,
sitting inside the fix for it.

## 63. `app.quit()` before app-ready doesn't stop the module

The single-instance guard called `app.quit()` and carried on: `registerIconScheme()` and the whole
`whenReady` handler were still registered, so a second copy briefly raced the first over the same
partitions — the exact thing the lock exists to prevent, and what corrupts a cookie jar.
`app.exit(0)` stops immediately.

## 64. Unread is read from the service, not tallied from its notifications

The count was a running total of `new Notification()` calls. Three consequences: it only ever went
up; it never reflected messages read somewhere else; and it was permanently zero for a service whose
browser notifications are off — Gmail displaying "(5) Inbox" reported nothing.

Now, where a catalog entry declares a pattern, the page title is treated as the **authoritative**
count. A title that stops matching means zero, which is how reading your mail on your phone clears
the badge here. That's a behaviour a tally structurally cannot have.

**Per-service and opt-in, which is the whole design.** A global `\((\d+)\)` parser is the obvious
idea and the wrong one: a Notion page called "(2) Draft", a Google Doc, a YouTube tab all match, and
each becomes a permanent phantom count. Rambox reached the same conclusion — it injects per-service
JavaScript as the primary mechanism and falls back to a title pattern only where a site has none. So
detection is declared per entry and simply absent for custom connections, where there's nothing to
know.

`\+?` in the pattern is load-bearing: without it "(99+) Slack" fails to match and a _busy_ Slack
reports zero. Caught by a test asserting each catalog pattern against the titles its service
actually produces.

## 65. Drag was broken on two of the four rail positions

`SortableRailList` hardcoded `restrictToVerticalAxis` and `verticalListSortingStrategy`. The rail
runs as a _row_ on the top and bottom edges, so with either selected the modifier clamped movement
to an axis the tiles didn't lie on, and `closestCenter` ranked candidates by a vertical distance
that was always zero. Reordering simply didn't work, on half the layouts the app advertises.

Both now follow the orientation the rail is already computing for its own class names.

Found by reading the file rather than by using it — which is the argument for auditing the renderer
at all. Everything Phase 4 found was main-process, and that said nothing about this side except
that nobody had looked.

## 66. dnd-kit's `attributes` nest a button inside a button

`useSortable().attributes` carries `role="button"` and `tabIndex={0}`, and they were spread onto the
wrapper `div` — which contains the tile's real `<button>`. That's one interactive element inside
another: a screen reader announces a button inside a button, and each tile takes two tab stops.

The drag-specific attributes (`aria-roledescription`, `aria-describedby`) are kept, because those
are what make the keyboard drag announce itself. Only the two that duplicate the child are dropped.

## 67. Pull-then-subscribe needs a guard against its own pull

`useShellState` and `OverlayRoot` both fetch once and then subscribe — the fix for the blank-overlay
bug in #13. But the fetch is _async_ and the subscription isn't, so a broadcast landing while the
fetch is in flight is then overwritten by the snapshot the fetch started with. `sync()` fires on
every mutation, so the window is small and entirely real.

Once anything has been pushed, the initial fetch is stale by definition and is dropped.

## 68. A keyless fragment in a mapped list

`Rail.renderService` returns a fragment — a button plus an optional label — and mapping it over a
folder's members produced a list with no keys. React then reconciles by index, so collapsing a
folder or reordering its members can carry one tile's DOM state onto another.

Keyed inside `renderService` rather than at each call site, since the fragment is what needs the key
and only one of the two call sites is a list.

## 69. The rail is buttons, not a tree — deliberately

The obvious accessibility fix for a rail of services and folders is `role="tree"` with `treeitem`
children. It was written, and then reverted.

A tree **promises arrow-key navigation with a roving tabindex**, and we don't implement that —
dnd-kit already owns the arrows for moving a lifted tile. Telling a screen-reader user "this is a
tree, use the arrows" and then ignoring the arrows is worse than a plain run of buttons that Tab
through correctly. ARIA roles are a contract about behaviour, not a vocabulary for describing
appearance.

So: native buttons, `aria-current` on the focused service, `aria-expanded` on folders, and a
labelled `role="group"` around a folder's members to convey the nesting. State that matters — asleep,
unread — goes in the accessible _name_, because `title` is announced inconsistently and only after
a delay.

Unread changes get one `polite` live region for the whole rail rather than `aria-live` per badge:
per-badge would announce every service's count on any change, and `polite` waits for a pause rather
than cutting across what you're reading.

## 70. The overlay needs a focus trap more than a web page would

It's its own `WebContentsView`. Tabbing past the last control doesn't move focus to a page behind —
there is no page behind. Focus goes somewhere with no visual representation at all and the user is
simply stuck.

The trap also restores focus on close, because the view is _removed_ from the window rather than
hidden (decisions #15), so whatever had focus is genuinely gone.

## 71. A focus-trap test that passes without the trap

Both trap tests initially passed with the trap disabled. Two separate reasons, and both are general:

1. **jsdom had nothing focusable outside the dialog**, so `dialog.contains(activeElement)` was
   trivially true. The escape hatch has to exist for closing it to mean anything — the tests now
   render bait buttons either side.
2. **Asserting only after the last press.** With a three-element focus cycle, twelve tabs land back
   where they started whether or not a trap exists. The tests now assert after _every_ press.

Same discipline as #53, where three dependency-cruiser rules reported a clean graph while looking at
nothing: **if a test is meant to prove something, break the thing and watch it fail.**

## 72. Playwright replaces the probe, because a diagnostic can't fail a build

`HANGAR_PROBE` drove the real app and reported with `console.log`. It found genuine bugs — the
isolated-world trap, the stale picker snapshot — but only ever told a _human_ something was wrong,
and only if they read the output. Roughly 300 lines of it lived in `boot/index.ts`, shipping in
production builds.

Eight Playwright tests now cover the same ground and either pass or stop the run. `boot/index.ts`
drops from 474 lines to 171.

**Each test was verified by reintroducing the bug it guards.** Putting back the `!runtime` check in
`handleNotification` and the `length === 0` check in the config guard failed exactly the two tests
that should have failed, and nothing else. A test suite that has never been seen to fail is a suite
of unknown value — the same reasoning as #53 and #71.

Two things make them deterministic: `HANGAR_USER_DATA` gives every run its own profile, so a test
can't touch the real config or sign anything out; and a local fixture server means no network and no
login, so they pass on a machine that has never opened Gmail.

`injectPush` and `serviceCount` stay on `AppWindow` — they were probe scaffolding, and they're now
test seams. `__hangarShell` is published only when `HANGAR_USER_DATA` is set, so a normal run never
exposes an internal handle.

## 73. The catalog invariant that matters isn't the one that's easy to test

`catalog.test.ts` asserts every entry allows its own URL. Expanding from 9 to 37 entries caught one
failure that way — Jira pointed at `www.atlassian.com/software/jira`, a marketing page whose host
wasn't allowlisted.

But that check is **static**, and the failure mode it can't see is a _redirect_. So every URL was
also fetched and its **final** host compared against the allowlist. That found four more, including
one in the code that had already shipped:

- **Notion has moved from `.so` to `.com`.** The existing entry's allowlist covered only `notion.so`,
  so the redirect was treated as an external navigation and opened in Safari. Live, in a service in
  daily use.
- **Signed out, every Google Workspace app redirects to `workspace.google.com`** — so the very first
  load, before you have a session, bounced out of the app. The same trap as the `/u/0/` marketing
  redirect in decisions #2, in a different disguise.

403s and 406s from a plain `fetch` are bot-blocking, not misconfiguration, and are ignored.

The general point: an allowlist is a claim about where a service will _send_ you, and only following
the redirect tests that claim. `Monday` also ships with no `icon` at all rather than a slug that
404s — `initials` is the designed fallback, and a declared-but-missing slug is indistinguishable
from a typo.

## 74. Config sync is an allowlist, and refuses rather than merges

Git-backed: a repo you control, pulled on launch, committed when the portable half changes. No
server, no account, and you get history and a real conflict model for free.

**An allowlist, not a blocklist.** A blocklist means every field added later syncs by default and
someone has to remember to exclude it — which is exactly how a machine-local secret ends up in a
shared repo. Three fields are explicitly local, and each would break something:

- `pushRegistrations` — an FCM registration is bound to one receiver. Two machines holding the same
  endpoint means both are wrong and neither gets the notification.
- `window` — describes this machine's display; `restoreBounds` would strand the window offscreen.
- `layouts` — a 4-pane split from a 32" monitor is unusable on a laptop.

Cookie jars aren't in `Config` at all, so the second machine gets your setup and asks you to sign
in. That's correct, and Settings says so rather than letting it look like a failure.

**Conflicts are never resolved automatically.** A merge guessing which machine's rename to keep can
cost an account-to-partition mapping, which signs you out of something you never touched. `--ff-only`,
then stop and report.

## 75. Three sync bugs only a two-machine test could find

The unit tests (18 of them) all passed while the feature didn't work. Each of these needed two real
clones of a real repo:

1. **A brand-new empty repo read as a conflict.** `git pull` on a repo with no commits fails with
   "no such ref was fetched" — and that's the _normal_ starting state. It also blocked the first
   push that would have seeded it.
2. **Asking the wrong repo whether it had commits.** The fix for (1) checked the _local_ clone, but
   a clone taken before the other machine's first push is locally empty while the remote is not —
   the ordinary state of the second machine you set up. It skipped the pull, tried to seed, and had
   the push rejected.
3. **`@{upstream}` doesn't exist on a clone of an empty repo.** No tracking configuration is written
   when there's no branch to track, so the upstream check silently found nothing. `FETCH_HEAD` is
   written by the fetch itself and doesn't depend on that config.

Unborn HEAD is now handled by adopting the remote wholesale rather than merging — `merge` refuses it
as "unrelated histories", and there are no local commits to lose.

## 76. `JSON.stringify(x, keys, 2)` sorts nothing

The second argument is a key **allowlist applied at every level**, not a sort order. Passing the
top-level keys to get stable output silently stripped every nested object's contents — so
`hasDiverged` compared two configs with all their preferences removed, and **a changed preference
didn't register as a change at all.**

Caught by a test asserting that it did. Stable output now comes from recursively sorting keys before
stringifying; arrays keep their order, because for `services` and rail items position _is_ the data.

## 77. The array-aliasing fix covered one direction only

Phase 2 fixed `merge` copying arrays when falling back to a default. It didn't copy them on the way
_in_ — so passing `DEFAULT_PREFERENCES.behaviour` **as** the stored value, which is exactly what
`resetPreferences` does, produced a result sharing `spellcheckLanguages` with the constant. The
first `push` to it would mutate the defaults for the rest of the process.

Found by a test asserting two independent resets don't affect each other.

## 78. Sync needs a last-synced base, or it cannot tell "behind" from "ahead"

`applyIncoming` replaced the portable half with whatever was in the repo, every time. With no record
of what was last synced there is no way to distinguish "the remote is newer" from "I have local
changes that never pushed" — and since `schedulePush` fired only from `set-preference`, the second
was the _common_ case.

Reachable on one machine: add a service, quit before the debounce, relaunch. The pull found the repo
unchanged and overwrote your services with the older copy. Account row gone, partition orphaned, one
console line.

`sync-base.json` in `userData` — deliberately not in `Config`, or it would sync itself — makes pull a
three-way decision. A missing base means we genuinely cannot tell, so it refuses unless both sides
already agree, which is correct and one-time.

Verified end to end: add a service, quit inside the debounce, relaunch — the service survives _and_
reaches the repo, because local was ahead so it pushed instead of pulling.

## 79. A credential was being committed to a git repo

`PORTABLE_KEYS` included `preferences` wholesale, and `preferences.notifications.firebase` holds an
API key. Every sync wrote it into the user's dotfiles repo — wrong even when that repo is private,
and a leak when it isn't.

Top-level exclusion wasn't enough: most of `preferences` is genuinely portable and a handful of
leaves inside it are not. `LOCAL_PREFERENCE_PATHS` now strips six, and the reasoning differs for
each — a credential, two absolute paths, a network-specific proxy, a transient timestamp, and one
that is simply per-machine. Pinned by a test asserting the serialised output contains neither the
key nor the string `apiKey`.

`sync.repoPath` was the funniest of them: the transport's own configuration travelling over the
transport, so the second machine adopted a path that didn't exist there and killed its own sync.

## 80. Splitting sync into pull and push was the mistake

Three bugs — pull and push racing over `index.lock`, a debounced push dropped and never re-armed,
and committing before fetching so the commit could never fast-forward — were one problem wearing
three hats: two independent entry points driving git in the same worktree.

Patching them separately would also have reintroduced #78, because fetching before a commit pulls in
a remote config the push then overwrites.

One `reconcile()` — fetch, decide, act — behind one mutex, with a re-run flag so a request arriving
mid-run is deferred rather than dropped.

## 81. Automated git must not prompt, and must not commit your work

Three ways the first version could hang or do damage in a repo the user actually works in:

- **`git commit` with no pathspec commits the entire index.** The Settings placeholder is literally
  `~/code/dotfiles`. Stage a half-finished change, toggle a preference, and Hangar commits and
  pushes your work-in-progress under its own message. `--only -- <file>` fixes it.
- **A credential prompt blocks on stdin** until the 30-second timeout and surfaces as an opaque
  failure. `GIT_TERMINAL_PROMPT=0` and the `ASKPASS` variables make it fail immediately with a
  readable reason.
- **The user's pre-commit hooks run.** A lint hook in their dotfiles repo should not be able to
  break config sync when we only touch our own file. `--no-verify`.

## 82. The conflict UI did the opposite of what its buttons said

`resolve('local')` and `resolve('remote')` both wrote the _remote_ as the new base — so they were
the same function. `decideSync` then saw local as the only side that had moved and returned
`push-local` for both, meaning **"Keep repo" pushed this machine over the repo**, discarding exactly
the copy the user had asked to keep.

The mechanism is nicer than a branch: set the base to the side being **discarded**, and the existing
three-way decision does the rest. Keep local → base := remote → local looks ahead → push. Keep repo
→ base := local → the remote looks ahead → apply.

A conflict UI that does the wrong thing is worse than no conflict UI, because the user believes it.
Pinned by a test asserting the two produce _opposite_ actions — an identical base would silently
invert one of them again.

## 83. Sync gets its own end-to-end suite, because units keep passing while it breaks

Every bug this feature shipped with survived a full set of unit tests. They passed because they
tested the design — two machines taking turns — rather than the way it's used: one machine, changes
that never pushed, a restart, a conflict nobody planned for.

Four Playwright tests now run real git against a real repo:

1. seeding an empty repo, and asserting the Firebase key and the repo path are **not** in the commit
2. a service added and never pushed **surviving a restart** — the P0
3. a conflict reported with **neither side modified**
4. "Keep repo" actually adopting the repo

Two harness lessons worth keeping: editing the repo while the app runs races its own debounced
reconcile, so the divergence is set up with the app closed — which is also the real scenario, since
two machines don't edit simultaneously. And `await`ing inside `app.evaluate` while `onApplied` tears
down and rebuilds every pane holds the call open past Playwright's timeout; dispatch and poll the
file instead.

## 84. A slice deleted the whole application lifecycle, and everything stayed green

Commit `c02cd4b` removed the `HANGAR_PROBE` diagnostic with a python slice from the probe's first
line to the `window-all-closed` comment. Everything between went too:

```
ttlForPartition · persistAll · setInterval(persistAll, 60s) · setInterval(hibernateIdle, 30s)
powerMonitor suspend/resume · before-quit → confirmQuit, beginQuit(), await persistAll()
```

The commit message reported "474 → 171 lines" as an achievement.

**Five daily-use failures, and the first is the app's entire premise:**

1. **Signed out of everything on every launch.** Session cookies are in-memory in Chromium;
   `promoteSessionCookies` at quit is why Phase 1 exists. Uncalled, every relaunch is a full round
   of re-auth — which reads as "Electron can't hold a Google session" rather than as a bug.
2. **The app could not be quit with close-to-tray on.** `beginQuit()` never ran, so `isQuitting()`
   was permanently false and the `close` handler `preventDefault()`ed forever. Force Quit only, and
   macOS logout would hang.
3. **Hibernation never ran.** A live Settings control wired to nothing.
4. **No wake refresh** after a lid close.
5. **`pruneSessions` never ran.**

**Why nothing caught it.** `tsc` was strict but not `noUnusedLocals`, so eleven imports referenced
only by their own import statement were fine. 347 unit tests passed — they cover pure functions, and
an uncalled function is still a correct function. `dependency-cruiser` passed — the imports still
existed. Twelve Playwright tests passed — **they boot, assert, and exit; none of them ever quits.**

Three fixes, in order of importance:

- `noUnusedLocals` + `noUnusedParameters`. This is the root cause and it is one line. It immediately
  found five more dead imports left over from the restructure.
- An E2E test that sets a session cookie, quits _properly_, relaunches against the same profile and
  asserts the cookie is both present and now persistent. Verified by re-deleting `before-quit` and
  watching it fail.
- The block restored verbatim from `c02cd4b~1`.

The general lesson is about what a test suite's _shape_ can see. Ours was pure-function unit tests
plus boot-assert-exit E2E. Between them they cannot observe an uncalled function, a timer that never
fires, or anything that happens at shutdown — which is precisely the region that was deleted.

## 85. A public-repo guard whose first design was engineered to be disabled

Config sync writes `hangar.config.json` into a repo you nominate. Credentials never travel — the
`LOCAL_PREFERENCE_PATHS` allowlist strips the Firebase key, with a test asserting the output contains
neither the value nor the string `apiKey`. But the file still carries service names, account labels
(usually addresses) and custom connection URLs, so writing it into a _public_ repo is a leak of
topology even though it isn't a leak of secrets.

The first design refused any remote on `github.com`, `gitlab.com` or `bitbucket.org`.

That is exactly wrong, and it took writing it down to see why: **those hosts are where private
dotfiles repos live.** The guard would have fired on the correct, common case. The override toggle
next to it would have been switched on within a day and never switched off, and every genuinely
public repo afterwards would have synced without complaint. A guard that trains you to disable it is
worse than no guard, because it also buys you the feeling of having one.

The rewrite makes an unauthenticated `HEAD` request to the repo's web URL. Verified against four
forges: a public repo answers 200, a nonexistent one answers 404 (403 on GitLab). Only 200 is
load-bearing, because **404 means private _or_ nonexistent and GitHub refuses to distinguish them** —
deliberately, so that probing cannot enumerate private repos. So the guard is decisive in exactly one
direction and fails open in every other, including offline.

The host list survived with the opposite job. It no longer marks where sync is _forbidden_; it marks
where an anonymous 200 can be _believed_. A self-hosted forge is deliberately absent — an internal
GitLab will happily answer 200 to a laptop on the VPN for a repo no outsider can reach, and refusing
to sync to your own company's git server is the same false positive in new clothes.

Two smaller things that would each have been a bug:

- **`fetch`, not `net.fetch`.** Electron's main process has both: the global is Node's, and
  `net.fetch` goes through the Chromium stack. The probe must be anonymous, and a session-backed
  request would attach whatever GitHub cookies your own browsing has left behind — turning "the
  public can read this" into "I can read this", which is true of every private repo you own.
- **`git remote get-url` applies `insteadOf` rewrites.** Discovered while trying to use that for a
  hermetic test, where it was an obstacle. In production it is correct and worth keeping: if you
  rewrite `https://github.com/` to a local mirror, the guard should judge where the data actually
  goes.

**On verifying it.** The pure half — URL parsing, the verdict table, the refusal — was mutation
tested: five deliberate breaks, all five caught. But none of those tests can see whether the probe is
_called_, and this project has already shipped a function with zero call sites (entry 84), a
duplicated block, and three dependency rules that silently matched nothing. So the guard also has an
integration test that runs the real `ConfigSync` against a real temp git repo with `fetch` stubbed —
hermetic, no network — and it was verified by deleting the probe's only call site, leaving
`probeVisibility()` perfectly correct and never invoked. Six of its ten tests failed. That is the
test earning its place.

## 86. "Impossible" was a conclusion, not a fact

Dragging a rail tile onto a pane sat in the backlog for the whole life of the project, marked not
possible, with entry 10 as the justification. Entry 10 is correct: the rail is one `webContents` and
each pane is another, and a DOM drag cannot cross that boundary.

The error was in what followed from it. A drag can't _travel_ between renderers — but nothing
requires a renderer to be the one deciding where a tile lands. Main already owns the pane geometry:
it computes `Layout.bounds` on every relayout, and it is the only party that knows where either
surface sits in the window. So the renderers were demoted to reporters. Each one says "the pointer
is at (x, y), in my coordinates"; main translates, runs `dropAt`, and sends back the one rectangle to
highlight. The tile lands wherever main says it lands.

Three things fell out of that inversion, and the third is the one that made it work at all.

**A transparent view over the panes, attached only during a drag.** It draws the drop indicator, and
it exists so there is something to draw _on_ — the panes are other people's web pages. It is
detached the instant the drag ends, and on relayout and teardown as well, because a transparent
`WebContentsView` hit-tests across its whole bounds and one left attached swallows every click in
the window. That is the same fact that rules out a permanent full-window overlay for the find bar.

**A frozen snapshot of the geometry, taken at the lift.** The alternative is recomputing per pointer
move, which would let the highlight and the drop disagree if anything relayouts mid-drag. Freezing
makes them agree by construction, and `relayout()` ends any drag in flight rather than letting the
snapshot go stale.

**Both renderers report, and main de-duplicates.** This is the part that isn't obvious. Whether the
pointer events keep going to the rail after the press, or start arriving at the layer once the cursor
crosses into it, is a mouse-capture detail that differs by platform — on macOS the view where the
press landed keeps the stream until release. Picking one and building on it would have produced a
feature that worked on the machine it was written on. Both surfaces send the same two messages; main
takes the first release and ignores the second, because the drag is main's state and a `drop-tile`
for a tile that was never lifted does nothing.

The cost is a message per pointer move. That was the objection to this design, and it's wrong at this
scale: renderer→main IPC is sub-millisecond, and it buys correctness on platforms nobody tested.

Two consequences in the rail worth keeping:

- **Keyboard lifts never involve the layer.** Attaching it takes the keyboard focus, so ⌃Space
  followed by an arrow key would end the drag on the first press. Keyboard drag stays a pure in-rail
  reorder, which is all it ever needed to be.
- **A release outside the rail must not also move the tile in the rail.** dnd-kit's `closestCenter`
  always names _some_ tile, however far outside the rail the pointer is, so `over` cannot be used to
  tell the cases apart. The rail compares the release point against its own viewport instead. This
  rule is a pure function (`moveOnRelease`) because it cannot be reached through a simulated drag:
  jsdom reports zero-sized rects, so dnd-kit never resolves an `over` in tests, and an integration
  test of it would pass whether the rule existed or not.

## 87. What a drop means is read from the target, not from the index

Dragging a service into a folder was the other thing filed as unbuilt, and unlike drag-to-pane it
had no structural blocker — the rail is one renderer and dnd-kit was already there. What stopped it
was an ambiguity nobody had named.

The rail draws an open folder's members inline, so the visible order is flat: tile, folder, its
members, tile. Make every row a sortable item and dragging works immediately — but the _drop_
doesn't mean anything definite. A service released between the last member of a folder and the next
top-level tile is at one index and two positions: last thing inside the folder, or first thing after
it. Sortable-tree implementations resolve this with horizontal offset — drag right to nest, left to
outdent, with an indent guide showing which you're getting. A column of 48px icons has nowhere to
put an indent guide, and no horizontal room to move in.

So the index is not consulted. `moveItemTo(workspace, activeId, overId)` reads the _target_:

- dropped on a folder tile → into that folder
- dropped on a member → into that member's folder, beside it
- dropped on a top-level tile → the top level, at that tile's position

Every case is one sentence, none of them needs a modifier key, and "drop it on the thing you want it
next to" is what people try first. Dropping onto a folder appends rather than inserting, so the
gesture means the same whether the folder is open or shut — a collapsed folder shows no members to
aim between.

Two consequences:

- **The renderer stopped deciding.** It used to compute the new order itself and send
  `reorder-items` with a full id list; that command and its `reorder()` helper are gone. The rail now
  reports the two ids and nothing else, which is the only version that can express "into a folder" —
  a flat list of top-level ids has no way to say it.
- **A folder dropped on a folder reorders.** Folders never nest, and this entry point is the easiest
  place to break that invariant, because for a service the same `overId` means the opposite thing.

**On testing it.** The pure rule has thirteen cases including an exhaustive "never loses or
duplicates a service" sweep. None of them proves dragging works, and neither does any unit test that
could be written: jsdom gives every element a zero-sized rect, so dnd-kit never resolves a drop
target and every simulated drag ends with `over: null`. **Every existing renderer test of the rail
drag would have passed with the feature deleted.** That gap is now covered by a Playwright test that
performs a real pointer drag against real layout, in both directions, verified by making a folder
drop reorder instead of file.

## 88. A rail that overlays the panes has two thicknesses, and only one of them is layout

> **Superseded by #95.** Hover-expand is gone: the rail is opened by a chevron and the panes reflow
> around it, so the two thicknesses are now always equal. Kept for the origin-shift and
> renderer-sizing findings, which still hold, and for why the hover version could not.

`compactRail` shipped as a rail that was merely narrower — 48px instead of 72 — while the Settings
row for it read "Collapse to a sliver, expand on hover". The setting had been describing something
that wasn't there.

The blocker on record was z-order: the rail is attached to the window before any pane, so it sits
_underneath_ them, and a rail that grew would grow behind the thing it was supposed to cover. True,
and a two-line fix — `removeChildView` then `addChildView` after the panes are attached, the same
manoeuvre `Overlay.raise()` already performed. It is done unconditionally rather than only for
compact rails: "the rail is in front of the panes" is one rule, and a rule that holds for one
preference setting is a trap for whoever changes the next one.

The part worth more than two lines is what the rail's _size_ means, because once it can expand there
are two answers:

- **`reserved`** — what the panes have to work around, which for a compact rail is the sliver,
  permanently.
- **`rail`** — what the rail view actually occupies, which is the sliver or the full preference.

Keeping those apart is the entire difference between an overlay and a layout change. If hovering
altered `reserved`, every page under the cursor would reflow twice per pass — and web apps are not
cheap to reflow. `railSizes` returns both, ignores `expanded` unless the rail is compact so no caller
has to check twice, and floors the expansion at the sliver so a hand-edited `railSize: 20` can't make
"expand" mean "shrink".

Three consequences that were not obvious:

- **The rail's origin moves.** A left rail grows away from its origin, so `railBounds` gives the same
  `x` either way — which is why using the reserved rectangle for everything looked fine. A _right_
  rail's origin shifts by the difference, and `beginTileDrag` translates every rail-relative pointer
  position through that rectangle. Drag on a right-hand compact rail would have been offset by 48px.
- **The renderer stopped sizing itself.** `.rail` was `width: var(--rail-size)`, set from the
  preference — a second copy of a number the view's bounds already carry, and one that arrives an IPC
  round trip later. Harmless at a fixed size; on every expand it is a frame of pane showing through
  the rail, or a tile clipped in half. It is `width: 100%` now, and the custom property is gone.
- **Hover is reported, not obeyed.** The rail is the only surface that can see the pointer, so it
  sends `set-rail-hover` — but main decides, and answers with `railExpanded` in `ShellState`. Two
  copies of that answer would disagree in exactly the case that matters: **a drag freezes it**. The
  pointer leaving the rail is the normal first move of a drag onto a pane, so a rail that collapsed
  on its own would collapse on every one of them, and take the frozen drag geometry with it.

The one hole in reporting from the renderer is the overlay: it is full-bleed over the whole window,
so opening the palette takes the pointer away without the rail ever seeing it go. Every route to the
overlay goes through `openOverlay`, which shuts the rail first, and losing the window shuts it too.

**On testing it.** None of this is reachable from a unit test — the size is a `WebContentsView`
bound, "over the panes" is an ordering among native views, and "without moving them" is the _absence_
of a relayout. The E2E test measures the rail's own viewport, the pane's viewport, and
`contentView.children`. Its first version passed against a rail that reserved its expanded width,
because hovering skips the pane arithmetic and nothing had recomputed the layout yet; forcing a
relayout while expanded is what catches the version of that bug which actually bites.

## 89. Rebinding was blocked by a second copy of the fact, not by missing UI

Settings showed the shortcut map read-only, and the obvious reading was that the form hadn't been
built yet. It hadn't — but building it would not have worked.

Three places each held their own copy of "⌘K opens the palette": `translate` in main, the menu
template in `boot/menu.ts`, and a hand-written list in Settings. They had already drifted; the
Settings list simply never mentioned ⌘F or ⌘P. The one that mattered is the menu, because
**`Menu.setApplicationMenu` registers accelerators at the application level, ahead of
`before-input-event`**. Move ⌘K to ⌘J in a preference and the menu's copy keeps opening the palette
on ⌘K regardless — the rebind reads as broken, and every unit test still passes, because the unit
under test was never the one dispatching.

So the menu now declares our own items with `registerAccelerator: false`: the chord is _drawn_
beside the label and Electron does not bind it. `before-input-event` becomes the only dispatcher and
`core/keyboard/keymap.ts` the only table — labels, order and separators included, so the menu cannot
drift from Settings again. Roles are the exception and keep their real accelerators, which is
precisely why ⌘Q, ⌘C and the rest are refused to rebinding: binding an action to one produces a
shortcut that silently never fires.

**The E2E test is the only place this is visible.** `translate` is pure and thoroughly unit-tested,
and all of it would pass against an app whose keystrokes were being handled by the menu. The test
presses ⌘K through `webContents.sendInputEvent` — the browser input path, not Playwright's
`page.keyboard`, which injects via CDP straight into the renderer and bypasses the entire shortcut
layer — then rebinds, then asserts both that ⌘K stopped working and that the menu item reports
`registerAccelerator === false`.

### Where the code went, and why it is in three places rather than one

- **`shared/keyboard.ts`** — what a chord _is_: parsing, canonical form, display. Settings has to
  turn a keypress into the same string main will store, and `renderer-is-sandboxed` forbids it
  importing core. Nothing here reads `process.platform`, because this file gets bundled into a page.
- **`core/keyboard/keymap.ts`** — which chords are _taken_: the action table, the reserved list, the
  ⌘-or-Ctrl decision, `translate`. Main-side, and free to ask the platform.
- **`ShellState.keyboard`** — the table as Settings draws it, projected by main. Conflict detection
  lives here rather than in the renderer because the tie-break rule (`KEY_ACTIONS` order) is what
  decides which of two clashing shortcuts actually fires, and a renderer re-deriving it would be a
  fourth copy free to disagree.

### Chords are strings, and `docs/preferences.md` had promised otherwise

That file said chords would be stored as `{ key, meta, alt, shift, ctrl }`. The reason they aren't
only shows up in the merge: `withDefaults` descends _into_ an object leaf and fills its missing keys
from the default. An unbound action has to be storable, and stored as `{}` it would come back
holding whatever chord it used to have — so clearing a shortcut would silently not stick. A
canonical string is a scalar, so `''` replaces, and it survives a git merge legibly.

### Taking a chord unbinds its previous holder

Refusing the assignment means telling someone to go and clear a different row first. Displacing is
what every shortcut editor people already use does, and the displaced action then reads "Not bound",
which is visible. Two actions quietly sharing one chord would not be — so a config that _does_ hold
one (hand-edited, or synced from a build with different defaults) is flagged on both rows rather
than silently resolved.

### Passthrough is per service, and the absent case is not the empty case

⌘K was the motivating bug: Hangar reads every keystroke before the page, so Slack's own switcher was
unreachable. The list is a `ServiceInstance` field, like zoom and custom CSS, so it rides the
existing per-service editor and the existing `update-service` command.

It is **optional**, and that is load-bearing. Absent means "follow the catalog", so Slack keeps its
⌘K out of the box and a future catalog change reaches existing installs; `[]` means "claim nothing",
which is how you take ⌘K _back_. Collapsing the two would make the catalog default unremovable. The
catalog writes `mod+k` rather than `meta+k` for the same reason `shared/keyboard.ts` avoids
`process.platform` — it is bundled into the renderer — and `resolvePassthrough` expands it.

### Two things found on the way

The menu's ⌘W was registered, so **closing Settings from the keyboard closed a pane behind it**.
With registration off it did nothing at all, which is worse; the Settings window now carries its own
two-line handler.

And only two of the five shell surfaces had shortcuts at all. The rail and the service views were
wired by hand, the overlay had a bespoke Escape listener and nothing else, and the find bar and
empty view had none — so ⌘K was dead on three of them. Registering a surface for state and giving it
the keymap are now one call, because they were forgotten separately.

## 90. The unread count could only go up, and the fix was not more JavaScript

Ten of 37 catalog entries read their count out of the tab title. For the other 27 the badge was a
tally of `new Notification()` calls, which has three failure modes and no good ones: it only ever
rises, it never learns that you read something on your phone, and it sits at zero for anyone who
turned that site's own notifications off — which is most people, since Hangar exists partly so they
can.

Rambox's answer is a JavaScript file per service, `eval`ed in the page. It works, and it is why
Rambox reaches services nobody else does. It is also ninety unauditable scripts, no way to test a
rule without launching the app, and a syntax error taking a service down with it.

**So a rule is data.** A selector, optionally an attribute to read, optionally how to combine
multiple matches — evaluated by one function in `core/notify/unread.ts` that is tested once and
drives every entry. The page-side code does no arithmetic at all: it runs `querySelectorAll`,
collects strings, and sends them. Everything that could be wrong about _what a badge means_ is
therefore in a pure function, which matters because of where the page-side code has to live.

### The anchor, which is the part that isn't obvious

"No badge on the page" has two meanings. Either you have read everything, or the SPA has not drawn
its sidebar yet. Guess zero and the count clears on every reload and every navigation; guess "no
information" and it can never clear at all, which is the bug we started with.

A rule can name an `anchor` — a selector for something that proves the app rendered. Anchor present,
badge absent, is a fact: zero. Anchor absent means the rule stays quiet and the next rule gets its
turn, which is also how one entry carries both current and legacy markup. `unreadFromDom` returns
`number | null` for exactly this reason, mirroring `unreadFromTitle`, and a test asserts the anchor
is never the same selector as the badge — point it at the badge and the two cases collapse back into
one.

### Why only two entries ship a rule

Salesforce and GitLab, and that is deliberate. `slds-*` is a published, versioned class contract;
GitLab's `data-testid` is the hook their own test suite asserts on, so it breaking is a change they
would notice too. Notion, Jira, Confluence, Trello, Asana, ClickUp, Monday and Figma all have a
badge and all ship generated class names, and **a selector nobody has watched a real page render is
worse than nothing**: wrong-and-matching-nothing is merely useless, but wrong-and-matching-something
is a phantom count that never clears and cannot be explained. That is the precise failure the module
docstring has warned about since the title patterns went in.

The other seventeen have no unread count at all — Docs, Sheets, Drive, Calendar, Meet, Zoom, Claude,
ChatGPT and the rest are not inboxes. "No rule" is the correct answer there, not a gap.

So the real deliverable is `ServiceInstance.unreadSelector`: a field for the person who can see the
page, which is never going to be a file in this repo. Absent follows the catalog; the empty string
is the deliberate "detect nothing", and the two must differ or a catalog rule that starts matching
the wrong node becomes unremovable — the same absent-vs-empty rule per-service passthrough needs,
for the same reason.

### Two things it forced elsewhere

`CommitOnBlur` discarded an emptied field, on the reasoning that blanking a workspace name is a slip
rather than a request. Right for a name, wrong here, where empty is the setting — so it grew an
`allowEmpty` opt-in rather than losing the guard everywhere.

And the rules are **pushed** to a live view, not only fetched at load. The whole argument for a
user-editable selector is that you tune it with the page in front of you; a selector you must reload
to test is one nobody tunes. Editing it, or muting the service, re-reaches the open page.

### Where the test had to go

The page-side probe is inside a serialised `executeInMainWorld` closure. It cannot import anything,
which means it cannot be imported either — the same wall decision #31 describes, and the reason so
little of `preload/service.ts` is unit-tested. There is no clever way around it, so the coverage is
an E2E test against a fixture page with two badges: it watches the count appear, follow a text
change, follow a _selector_ change with no reload, and then **go down to zero when the badge is
removed**, which is the one thing an event tally can never do. Commenting out the rule-push listener
fails it at the selector-change step and nowhere else.

## 91. Borrowing the login is a whole integration tier; holding a token is a different one

Both unread mechanisms in [#90](decisions.md) read a rendered page, so both need a live
`WebContentsView`. A hibernated service has none — and hibernation is what makes a rail of twenty
services affordable, so **the count you most want belongs to the service least able to give one**.
Web Push closes this, but only for someone who has stood up their own Firebase project, which is a
lot of setup for what should be a background GET.

So: ask the service. `session.fetch` issues a request on a partition's own cookie jar, which means
being signed in _inside Hangar_ is what authenticates it. No OAuth client, no token, no secret in
the source — and signing out breaks it, which is the correct behaviour rather than a case to
handle. The rule is data for the same reason a DOM rule is: a URL plus a declarative extractor,
evaluated by one tested function.

### Only while the service is asleep, and that is not an optimisation

Title detection, DOM detection and an endpoint all write an _absolute_ count. Two absolute sources
for one service is a badge that flips to whichever answered last, which is the flapping the catalog
test forbids for `titlePattern` + `dom`. A live page is fresher and free, so the endpoint waits for
it to go away. The pleasant side effect is that the request rate is bounded by how much you
hibernate: a service you keep open all day is never called at all.

### The refusals are the feature

The count is one line. Everything around it is about a credentialled request the user did not ask
for:

- **The URL must be on the service's own allowlist.** This is the one that matters. The rule can
  arrive from a hand-edited config, an import, or a sync from another machine, and without this
  clause any of those is a request carrying that service's cookies to a host of someone else's
  choosing. `isAllowedHost` already existed for navigation; this is the same question.
- **`redirect: 'error'`.** An expired session redirects to a login page. Following it hands the
  cookies to whatever the redirect named, and returns a 200 full of HTML that fails the extractor
  anyway — the same "no information", reached worse.
- **A failure is never zero.** 401, 429, 503, a parse failure, a path that no longer resolves: all
  `null`. Reading any of them as an empty inbox silently clears a real count, and looks exactly like
  the feature working.
- **A floored interval, a 10s timeout, one request in flight per service.** A rule with a typo'd
  interval should cost one request a minute, not become an accidental load test that gets the user
  rate-limited; and an endpoint that accepts the connection and never answers would otherwise hold
  its slot and stop that service being polled for the rest of the session.
- **Muted services are not called.** Muting means not hearing from a service, and a background
  request on its behalf is the clearest possible case of hearing from it.

### Gmail ships a rule; the DOM selectors mostly did not

That looks inconsistent with [#90](decisions.md) and isn't, because the failure modes differ. A
speculative CSS selector can match the _wrong node_ and invent a count that never clears and cannot
be explained. An endpoint rule cannot: a signed-out session is refused, a changed response fails the
regex, and every path returns "no information". The worst case is that it quietly does nothing, so
the bar for writing one down is lower.

### What is _not_ built, and why it is not a coding task

The third tier — real service APIs for the handful worth first-class treatment — needs a token, and
that is where it stops being about code:

- Slack, Salesforce, Atlassian and the rest issue tokens to a **registered OAuth client**, whose
  secret cannot ship inside an open-source binary that anyone can unzip. Salesforce is already
  flagged for this in the catalog: its `sid` is invalidated server-side on browser close, and the
  only real answer is a connected app with a refresh token.
- The subset that avoids OAuth entirely — GitHub, Linear and Todoist all let a user mint a personal
  token — is genuinely shippable, but it needs somewhere to _put_ the token. `config.json` is
  synced to a git repo, and the strip list that keeps the Firebase credential out of it
  (`LOCAL_PREFERENCE_PATHS`) is keyed on **preference** paths. A per-service token lives on
  `ServiceInstance`, inside `config.services`, which that list does not reach — so the first commit
  after pasting a token would publish it.

Both are real work with a decision in front of them, rather than the next function to write. The
session-borrowed tier is deliberately the one that needs neither: it is the only one where the
credential is something the user already gave the service, held somewhere Hangar never has to read.

## 92. A missing terminal is not an error, and the app should not die of one

The app was found dead one morning with a dialog reading `Uncaught Exception: Error: write EPIPE`,
on a stack that ran through `console.error` inside Electron's own `WebFrameMain.send`. The lid had
been closed overnight, so sleep looked like the cause. It wasn't.

`npm run dev` had been started from a terminal that later went away, leaving stdout and stderr as a
pipe with no reader. The 60-second session-persistence loop logs unconditionally, so from that
moment a crash was arithmetic: the next write raises `EPIPE`, and there was no
`process.on('uncaughtException')` anywhere in the app. Waking the machine only chose _which_ write
died — the wake reload sent state to a frame that had gone, Electron logged that internally, and
that log line was the one that landed on the dead pipe.

Three things follow, and they are separable.

### The write is where it has to be caught

`platform/logging.ts` wraps `console` so the first broken write mutes the rest. Once output has
nowhere to go there is nothing to be gained by trying again, and the loop that would keep trying
runs every minute for the life of the process.

It also catches Electron's own logging, which is the part that mattered here: internal code resolves
`console.error` from the global at call time, so replacing the global covers writes this codebase
never makes. Anything that is _not_ a broken pipe still throws — a console that swallowed everything
would hide bugs in whatever was being logged, and this exists to remove one condition, not to make
logging unfailable.

### Registering an uncaughtException handler replaces Electron's, it does not join it

Worth stating because it is the opposite of how Node listeners usually behave. Electron's handler in
`lib/browser/init.ts` opens with `if (process.listenerCount('uncaughtException') > 1) return`, so
the moment an app adds one, Electron's stops running. A handler that swallowed a broken pipe and did
nothing else would therefore have silenced _every_ crash dialog in the app while appearing to fix
one narrow bug.

So `reportFatal` reproduces Electron's dialog verbatim, including not exiting afterwards. The
`unhandledRejection` handler rethrows for the same reason: Node's default is to raise it as an
uncaught exception, and quietly downgrading every unawaited promise to a log line is not a fix.

### `safeSend` could never have caught this, and now doesn't need to

The obvious reading of that stack is that `safeSend`'s `try` was insufficient. It was irrelevant.
`webContents.send` delegates to `webFrameMain.send`, which catches the disposed-frame error _itself_
and reports it with `console.error` rather than rethrowing. No `catch` at the call site can see it,
and the log line lands either way.

The only way not to produce it is not to send, so `safeSend` now checks `mainFrame` and its
`isDestroyed()` before calling. Reading `mainFrame` is itself inside the `try`, because a
`webContents` torn down since the line above throws on the property access.

### What sleep actually broke, once the crash was out of the way

Three things, none of which had been visible behind the crash:

- **Push sockets.** They die with the network, but nothing notices: the peer vanishes without a FIN,
  so `ON_DISCONNECT` waits on a five-minute heartbeat and the backoff can add five more. Ten minutes
  of missed notifications after every lid open, presenting as a slow service. `reconnectAll()` on
  resume costs one round trip per service.
- **Hibernation.** Idle time is wall-clock distance from `lastActiveAt`, which is correct while the
  machine is awake and wrong the moment it isn't. An overnight sleep made every off-screen service
  hours idle at once, so the first sweep after wake unloaded all of them. `creditSuspendedTime`
  pushes the stamps forward by the suspended span, making the timeout mean "time you could have used
  this and didn't" — which is what a user reads it as.
- **Endpoint polling.** Everything overdue on wake gets the same `lastPolledAt` from the sweep that
  clears the backlog, and stays in lockstep from then on. `pollJitterMs` derives a fixed per-service
  offset from the service id — deterministic so a test can assert it, and _only ever later_, because
  `MIN_POLL_SECONDS` is a rate limit and drifting earlier would breach it.

### The cookie line that made it inevitable

The pipe had a writer every 60 seconds because Gmail reported `rejected 1` on every sweep, forever.
That was two defects in one line. `__Host-` cookies are only valid with no `Domain` attribute, a
path of exactly `/`, and `Secure`; `cookies.get` reports a resolved host in `domain` regardless, and
handing that back is rejected every time — so those cookies never gained an expiry and Gmail asked
for a sign-in after every restart. And the log printed an unchanged result once a minute, which is
not information.

Both are fixed, and the log now names the cookies. That last part immediately paid for itself:
Teams' equivalent line is `promoted 1 (esctx)` — Azure AD reissuing its session-context cookie on
each round trip, which is the service's business and not a bug here. A bare count could not have
said that.

## 93. A LaunchAgent gets launch at login without a signature

[#45](#45-launch-at-login-needs-a-signature-and-has-to-be-verified-by-reading-back) concluded that
launch at login was blocked until there was a Developer ID. The diagnosis was right and the
conclusion was wrong: what needs a signature is _that API_, not the feature.

macOS has two routes to a login item. `SMAppService` — which `app.setLoginItemSettings` uses on
modern macOS — registers a job **owned by a bundle**, identified by its code signature, so there is
nothing to register when the bundle is unsigned. The legacy route is a plist the user drops in
`~/Library/LaunchAgents`, which launchd reads at login on the authority of the file's location. It
is the user's own home directory; no third party is being asked to vouch for anything. Apple
deprecates it and still honours it, and `AssociatedBundleIdentifiers` is their own guidance for
making System Settings attribute such a job to an app by name rather than listing it anonymously.

So `applyLoginItem` writes a plist. It also _replaces_ the old call rather than joining it: on a
signed build both mechanisms would be live at once, and login would start Hangar twice with the
single-instance lock throwing one away.

### The app writes the file and never runs `launchctl`

The complete implementation looks like it should be write-the-plist-then-`launchctl bootstrap`, so
the setting takes effect now instead of at the next login. That version can make the app kill
itself.

`applySystemPreferences()` runs the `login-item` effect at boot **and on every `activate`**. Once
Hangar is running as the launchd job, `bootout` terminates it — so turning the relaunch setting off
would quit the app as a side effect, and so would ⌘W then clicking the Dock icon.

Writing a file has no such edge. It also makes idempotency trivial: compare the desired contents
with what is on disk and skip when they match, with no "already bootstrapped" error to interpret.

### Supervision cannot start before the next login, so it must not appear to

launchd only supervises processes it started. A Finder-launched Hangar is not one, and no `KeepAlive`
setting reaches it.

This is what makes bootstrapping from inside the running app worse than useless rather than merely
premature: launchd's new instance would hit the single-instance lock, exit 0, and — because of
`SuccessfulExit: false` — never be restarted. Nothing supervised, nothing running under launchd, and
no error anywhere. It would look like it worked.

The same fact invalidates the obvious way to test it. Killing the running app to watch it come back
fails, and the failure looks like a broken plist rather than the expected result. **Verification has
to cross a logout.**

It also settles what the two toggles mean together: relaunch without launch-at-login would be a job
that never starts the app and therefore can never restart it. `launchAgentWanted` returns false
unless `launchAtLogin` is on, and the Settings note says so, rather than writing a plist that cannot
do what its name claims.

### `SuccessfulExit: false`, and what the toggle does not cover

A bare `KeepAlive: true` would make Hangar unquittable — every deliberate exit in the app is
`app.quit()` or `app.exit(0)`, so launchd would restart it immediately, from inside the app, with no
way out. The dict form restarts only after a _non-zero_ exit, which is exactly the intended split.

What that covers is the process dying: native crashes, OOM kills, Force Quit. It does not cover a
JavaScript exception, because [#92](#92-a-missing-terminal-is-not-an-error-and-the-app-should-not-die-of-one)
deliberately keeps the process alive through one. Hence "stops unexpectedly" on the control rather
than "crashes" — the narrower claim is the true one.

The one unpleasant consequence, worth knowing before meeting it: Force Quit becomes sticky. The
escape hatch is `launchctl bootout gui/$(id -u)/com.hangar.desktop`.

## 94. The allowlist guarded the door the page opens and not the one the server does

`attachNavigationGuards` checked `will-navigate` and `setWindowOpenHandler`. Electron only emits
`will-navigate` when _the page_ asks to navigate — a link click, a `window.location` write. A
server-side redirect emits **`will-redirect`**, and there was no handler for it anywhere in `src/`.

So an allowed host could 302 the main frame to any host at all, and the frame would follow it while
still carrying that service's cookie jar. This is the identical hole the code already worried about
for popups: the allowlist is checked on the URL a popup _opens_ with, so `did-create-window` recurses
the guards into the child ([session.ts](../src/main/platform/session.ts)) to stop it navigating
somewhere else afterwards. The main frame had the same gap and no equivalent.

Both events now run the same check. `attachNavigationGuards` also had **zero test coverage** —
only `isAllowedHost` was exercised, indirectly, through the catalog — so `tests/main/navigation.test.ts`
is part of the fix rather than a follow-up.

### Blocking loudly, but not destructively

Two things were wrong with how a block presented itself, and they pull in opposite directions.

Every refusal was **silent**. A bounced sign-in step and a service that simply will not load are
indistinguishable from outside, which is how a Teams pane that never finished loading went
undiagnosed. Every deny path now logs the service and the full URL.

But the obvious next step — showing a "blocked" page in the pane — would have been a regression.
`will-navigate` fires on ordinary external link clicks, and today clicking a link in Gmail opens the
browser and _leaves Gmail exactly as it was_. Replacing the pane on every block would break the most
common case to serve the rarest. So `blockedPageHtml` is conditional on `shouldShowBlockedPage`:
only when the pane holds nothing worth keeping — never committed, `about:blank`, or one of our own
data-URL pages. A test asserts a good page is never replaced.

`preventDefault()` on `will-redirect` cancels the whole navigation rather than one hop, which is
precisely the case that leaves a dead pane. The two changes need each other.

### `extraAllowedHosts`, and why it is not a merge

The blocked page offers to allow the host. Writing that into `allowedHosts` would have been wrong
twice over: an instance list _replaces_ the catalog rather than extending it, so a naive write
discards every other host the service needs — and even a correct union would pin the instance to
today's catalog forever, losing the property `resolveUrl` exists to preserve, where resolving at
load time "lets a catalog fix reach installs that already exist". Hosts drift for the same reasons
URLs do; Teams moved to `teams.cloud.microsoft` inside this project's lifetime.

So it is a separate, additive field, unioned at check time. The guards also re-read config per
navigation, because they are attached once in `ServiceManager.ensure()` and `ensure()` returns
early for a live runtime — a captured `svc` meant a newly allowed host did nothing until the view
was destroyed and rebuilt.

The Allow button takes **no argument**. The service preload is in every service page, so a host
passed up from the page would let any service widen its own allowlist; main applies the host it
just blocked for that service and nothing else. The same reasoning as `serviceIdForContents`:
the sender does not get to name things.

### What this did and did not explain about Teams

Nothing, as it turned out. Tracing the redirect chain showed `teams.microsoft.com` stays on its own
host throughout, so no redirect was being refused. The actual cause was plainer: consumer Teams is
a _different app_ at `teams.live.com`, absent from the allowlist, so signing in with a personal
account was refused mid-load and left a work Teams that could not be typed into.

Worth recording because the investigation was built on the redirect theory and the theory was
wrong. The bypass was real and worth closing on its own merits; it just was not this bug.

## 95. The auto-expanding rail could not be made to close, so it stopped opening on its own

`compactRail` (#88) opened on `pointerenter` and closed on `pointerleave`, floating over the panes
so nothing reflowed under the cursor. Opening worked. Closing did not: the rail would stand open
over a pane indefinitely, and the report was that hovering it "just shows up and lingers".

The open half only needs the rail's own renderer to see the pointer arrive, which it does. The close
half needs it to see the pointer _leave_ — and the pointer leaves by crossing into a pane, which is
a different `WebContentsView`. Chromium tracks the pointer per view and does not reliably synthesise
a leave for the view being exited when a sibling view takes it. There was no event to close on.

Every available patch is a worse bug. Polling the cursor position against the rail rectangle is a
timer deciding what the input system already knows. Closing on the _pane_ reporting a pointer enter
needs a preload in every service page reporting mouse movement to main. Neither addresses that an
expanded rail is a view sitting over a page: an attached view hit-tests its whole rectangle, so the
overlap silently swallowed clicks meant for the service underneath — the same class of bug as a
stranded overlay or drag layer, and the reason both of those are detached rather than hidden.

So expansion is a click, on a chevron, and the panes reflow around the rail instead of passing
underneath it:

- **`reserved` and `rail` are always equal now.** `railSizes` still returns both — the callers and
  the origin-shift problem in #88 are unchanged — but a compact rail is 48px shut and a 180px panel
  open, and the panes are laid out against whichever it currently is. The rail is never over a pane,
  so there is no overlap to swallow anything.
- **Collapsed is 48px and draws every tile; open is a 180px panel.** See the amendment below —
  30px-and-no-tiles was tried first and made switching service a three-click round trip.
- **The traffic lights had to move.** `chromeFor` gave a left rail `topStrip: 0` and centred a 52pt
  span in it. At 48px that is `x: -2` — the window controls off the left edge of the window. It now
  reserves the strip for any rail too narrow to hold them, and decides from the rail's _collapsed_
  width rather than its current one, so the strip does not appear and vanish on each toggle and
  shunt every pane 38px down the window and back. `windowButtonPosition` keys off `topStrip` rather
  than re-deriving the answer, so the two cannot disagree about who is holding them.
- **`railExpanded` is still main's, and still not persisted.** A drag freezes it for the reason #88
  gives. Not persisting it is new: it is one click either way, and a rail restored open is precisely
  the screen space the preference exists to reclaim.

The renderer no longer sends `set-rail-hover` at all — there is no hover path left to get wrong —
and `openOverlay` and the window `blur` handler no longer force it shut, because neither was
compensating for anything any more.

### `startHidden` applies to a launch, not to every start

> **Superseded by [#96](#96-an-unreachable-window-is-worse-than-a-window-at-login).** The setting
> has been removed. The reasoning below held for development runs and missed what it did to the
> installed app.

Reported as "nothing is loaded when I run `npm run dev`". Nothing was wrong with the build: the
probe log showed a complete, healthy boot — window bounds restored on-screen at 1440×940, the rail
renderer finished loading 0.33s in, Teams committed its URL at 4.65s — and `focusedWindow: false`
on every single relayout. The app had started perfectly and hidden itself, because
`behaviour.startHidden` was on and `boot/index.ts` applied it to any start whatsoever.

The setting reads "Launch to the tray rather than a window", and the emphasis belongs on *launch*.
It exists so that logging in does not throw a window at you. A run someone has just typed into a
terminal is the most attended launch there is, and hiding from it produces no window, no error and
no clue — the failure looks like a broken build rather than a setting doing its job.

So it is gated on `app.isPackaged`. A development run never hides.

This is narrower than it could be. The exact condition is "was this start caused by the login item",
and the launch agent's `ProgramArguments` are ours to write, so a flag there would let a packaged
manual launch — double-clicking the app in the dock — show its window too, which it currently does
not. That needs the plist rewritten on existing installs, so it is left for when the launch agent is
next touched.

### Amendment: collapsed keeps the icons — 48px and 180px, not 30px and `railSize`

Hiding the tiles was the wrong half to cut. A 30px chevron reclaimed the most width and made the
rail's whole job worse: switching service went from one click to three — open the rail, click the
tile, close the rail again — because the thing you collapsed the rail to get out of the way is also
the thing you need every time you change service. The width it bought back was real; the cost was
paid on the most frequent action in the app.

Chrome's vertical tab strip is the resolution, and it is the shape this should have been:

- **Collapsed shows every icon.** 48px is one 36px tile plus its padding. No labels, no drag strip,
  no dividing line — but every service is still one click away, which is the only property that
  made a rail worth having. Add and Settings stay in the collapsed footer for the same reason
  Chrome keeps its new-tab button there.
- **Open is a 180px panel, not `railSize`.** The labels are the entire difference between the two
  states, so they are laid out _beside_ the icons rather than under them, and the width is its own
  constant. `railSize` is sized for a column of icons — reusing it meant opening the rail bought a
  wider strip of background and a row of ellipsised names. `railSizes` still takes the larger of
  the two, so a deliberately wide `railSize` is not overridden. 240 was tried first, copied
  straight from Chrome, and reported as "too big, look at all the empty space": Chrome is sizing
  for page titles, and these are service names.
- **The tile is the whole row, and the row is the click target.** The label started out as a
  sibling of the button — visibly part of the tile, and dead to the pointer. `rail input` logged
  the clicks arriving at the rail and nothing following them, which is the signature of a control
  that looks pressable and is not.
- **The chevron is the only way out, and the background stays inert.** Dismiss-on-background-click
  was tried here and reverted within the hour: "it automatically closes when I click on the
  vertical area under the icons." The reasoning for it was that the empty column is most of the
  panel and ought to do something. That is exactly why it fails — a target that large collects
  every stray, mistimed and misjudged click, so the panel appeared to shut by itself. Dismissing
  on outside-click works for a menu because the outside is the rest of the screen and clicking it
  is unambiguous; the inside of a panel is not "outside". The rail is a persistent piece of
  furniture rather than a transient popup, and closing it stays an explicit act on one control.
- **The row is a flex row, and `display: flex` is the whole trick.** `.rail-item` is a `<button>`
  with no display of its own. Setting `justify-content` and `gap` on it did nothing at all: the
  icon stayed centred by the button's inherited `text-align` and the name wrapped underneath it,
  which looked like the panel had ignored its stylesheet.
- **The name is `--text`, not inherited.** `.rail-item` sets `color` to the service accent so the
  focused-pane bar can pick it up from `currentColor`'s neighbourhood. Letting the label inherit
  that produced a column of red, blue and green names.

### Renaming happens in the panel, in place

Two services added from one catalog entry arrive with the same name — two tiles both called
"Teams" — and until the panel existed there was nowhere in the rail for a name to be wrong in.
Right-click ▸ Rename… opens Settings, which is a page away and does not say which of the two
identical rows you meant.

Double-clicking a name in the panel turns it into a field. It reuses `CommitOnBlur` — the same
component Settings uses, so Enter, Escape and click-away already behave — and dispatches the
existing `rename-service`. Which row is being edited is renderer-local, because an abandoned edit
is not something main needs an opinion about.

Right-click ▸ Rename… now opens that same field instead of Settings, which needs main to ask the
rail for something. It sends `begin-rename-service`, and the answer comes back on `ShellState` as
`renameRequest: { serviceId, nonce }`.

**The nonce is the whole design.** A bare `renameServiceId` cannot work: `ShellState` is
re-broadcast in full on every unread tick, pane change and preference write, so a plain field is
indistinguishable from a fresh request and the field would spring open again seconds after you
finished with it. Clearing it after broadcast is the obvious alternative and is a race — main would
be relying on the rail having rendered before the next broadcast lands. A monotonic nonce makes the
request an *event*: the rail records the one it acted on and ignores every repeat, main never has to
clear anything, and a stale request riding along with unrelated state is inert. This is why it is
not modelled on `flashServiceId`, which clears itself on a timer — an edit lasts as long as the
person doing it.

Main opens a collapsed rail before sending, since the field replaces a name and a collapsed rail has
no names on it. Where there is no panel to open at all — an ordinary 72px rail, or a horizontal one
— the rail falls back to opening Settings rather than dropping the request. That decision sits in
the renderer because the renderer is what knows whether it can draw the field.

Two hazards, both found by tests rather than by reading:

- **The field cannot live inside the tile.** A text input is not permitted content for a `<button>`,
  so the whole row is swapped for a non-button while editing.
- **Space starts a drag.** The row is a dnd-kit draggable and its keyboard sensor treats Space on
  a focused draggable as "lift this", so typing a two-word name lifted the tile. The field stops
  keydown propagation.

Clicking away from a half-typed name commits it and leaves the panel open, which is `CommitOnBlur`'s
existing behaviour and needs nothing added now that the background does not also collapse the rail.
- **Labels ignore `showLabels` when open.** On an ordinary rail that preference trades a name for
  vertical density and is worth having. In an opened panel, unlabelled icons would make the state
  indistinguishable from the collapsed one at four times the width, so it is not offered.

The traffic-light reasoning above is unchanged and now has a second reason to hold: 48px is still
under the 52pt span, so the top strip is reserved in both states either way.

## 96. An unreachable window is worse than a window at login

Reported as "it doesn't open up at all even though it's running". It was running: main, four
renderers, GPU and network service, a healthy boot in the log. It had no visible window, and nothing
the user did could produce one. Four things combined, and the first is the one this repo's own docs
recommended:

1. **`startHidden` hid every packaged start.** The note above gated it on `app.isPackaged`, which
   fixed `npm run dev` and left every launch of the installed app hidden. `docs/packaging.md` told
   you to turn it on.
2. **`activate` only focused.** A Dock click, a Finder double-click and a Spotlight launch of a
   running app all arrive as `activate`, and its handler called `win.focus()` when a window existed.
   Focusing a hidden window does nothing visible. `second-instance` had been fixed to call
   `showWindow()` for exactly this reason — "relaunching from Spotlight looked like the app had
   died" — but on macOS LaunchServices activates the running copy rather than starting a second
   one, so `second-instance` never fires for any of those.
3. **The tray was blank.** Its icon was an SVG handed to `nativeImage.createFromDataURL`, which
   decodes PNG and JPEG and nothing else. With no unread its title was `''` too: a zero-width item.
   The tray was the route back every other part of the design leaned on ("the tray is what makes
   close to tray and start hidden safe to offer"), and it could not be seen or clicked.
4. **Force Quit made it worse.** Under the LaunchAgent with relaunch-on-crash, a force quit is an
   unsuccessful exit, so launchd started it again 30 seconds later — hidden. The log has three boots
   in the same minute.

**What changed.**

- **`startHidden` is gone**, not re-gated. The precise condition — "this start came from the login
  item" — is detectable (a flag in the plist's `ProgramArguments`), but the setting's whole value is
  one window you didn't ask for at login, and its failure mode is an app you can't reach. Those are
  not comparable costs. Close to tray stays: it hides a window you *just* closed, and the ways back
  now work. The stored key is dropped by `withDefaults`, which keeps only keys the defaults define,
  so no migration was needed.
- **`ensureShell()`** is the single way to put a window in front of the user — build one if there
  is none, then `showWindow()`. `activate`, `second-instance` and the menu's "Show Hangar" all call
  it, so they cannot drift apart again.
- **Every route back is registered before the window is built**, and each preference effect is
  wrapped on its own. A throw from `new Tray()` in `applySystemPreferences` used to escape boot
  before `activate` or any IPC handler existed.
- **The tray glyph is pixels** (`features/tray-glyph.ts`), rasterised from signed distances at 1x
  and 2x, with a warning in the log if the image is ever empty.
- **More than one way back**: Window → Show Hangar, and the Dock icon's right-click menu, neither of
  which depends on the menu bar having room for the tray.
- **Bounds are re-checked on show**, not only at construction, and the check itself is stricter
  (`core/workspace/window-bounds.ts`): the title strip must be on a display, not any one pixel of
  the window, and the size is clamped to the display. A window closed to the tray on a monitor that
  is later unplugged used to come back from `show()` exactly where it was.
- **Quit is bounded.** Cookie promotion gets three seconds, not forever, so a stalled flush no
  longer turns ⌘Q into Force Quit into a launchd relaunch.

**Signing, found on the way.** `npm run dist` passes `identity=null`, which makes electron-builder
skip signing entirely, and Electron 43 documents that macOS does not deliver notifications to an
unsigned app. Nothing logged it — `Notification` has a `failed` event and nothing listened. It does
now, and `npm run install:local` signs every local build: with a self-signed "Hangar Local"
certificate if `npm run cert:local` has made one, ad-hoc otherwise. Ad-hoc is a hash of the bundle,
so camera and microphone grants are asked again after each rebuild; the certificate is the same
identity every time. See docs/packaging.md.

**Installing over a running copy.** The installed copy is usually the launchd job, so it cannot
simply be killed — that is a crash, and launchd restarts it mid-copy. `Hangar --quit` asks the
running copy to quit through the single-instance handoff: no confirm dialog, cookies promoted, exit
0. It travels as the lock's `additionalData` rather than a parsed argv, and with nothing running a
`--quit` exits before boot rather than starting the app it was meant to stop.

**One more guard.** Every packaged copy rewrote the LaunchAgent to point at itself on boot, so trying
out a build straight from `dist/` repointed login at the build directory. Only a copy in an
Applications folder may claim it now (`isInstalledCopy`).

## 97. The app's own screens hold the bridge, so they may only show the app

The rail, Settings, the overlay, the find bar, the drag layer and the empty view all load
`sidebar.cjs`, which gives them `window.hangar` — and `send` takes any command there is: add a
service, point sync at a repo, give Gmail custom JavaScript. Service views had navigation guards
from the start (#94); these had none. Dragging a link onto the rail navigated the rail to that page
with the bridge still in it, and `shell:command` answered whatever sent it.

**Two halves, because either alone is one bug from nothing.**

- **The screens are locked** in `loadRoute`, the one place every internal screen is loaded — which
  is also why Settings now goes through it rather than loading itself, the way it had come to be the
  one screen that would have missed this. `will-navigate` and `will-redirect` are refused for any
  URL that isn't this renderer, `window.open` goes to the browser (through the same filter as
  everything else) and never to a window that would inherit the preload, and `<webview>` is refused.
  "This renderer" is the dev server's origin in development and the exact path of `index.html` in a
  build — the path, not the scheme, because dropping a file is a navigation to `file:` too.
- **IPC checks the frame.** `shell:*`, `overlay:get-mode` and `app:metrics` answer only when
  `senderFrame.url` is the app, and log what they ignored. The frame and not the webContents,
  because a webContents is a container and what matters is the document in it when it sent.

**Everything that leaves goes through `openExternalSafely`.** Four call sites handed URLs straight
to `shell.openExternal`, which opens whatever handles the scheme: `file:` launches apps,
`x-apple.systempreferences:` opens System Settings, `smb:` mounts shares. Now an allowlist — the
web, mail and phone links, and the meeting and desktop apps a web service legitimately hands off to
— and five opens per ten seconds per source, so a page opening popups on a timer produces five tabs
and a log line. The rejection that a missing handler produces (`zoommtg:` with no Zoom) is caught;
it used to reach the unhandled-rejection guard and become a modal dialog.

**Permissions are the requesting frame's, not the partition's.** The handler captured whichever
service first created the partition, so an embed inside Slack got the camera because Slack is in
the catalog, and a second service on the same Google account was judged as the first. Now each
webContents is registered to its service as its guards attach (popups included), the request's own
URL has to be on that service's allowlist, and the service is read fresh from config — so toggling
camera and microphone takes effect on the next request rather than after a restart. A third-party
frame gets fullscreen, pointer lock and sanitised clipboard writes, and nothing else.

**Screen sharing works now**, and never on a page's say-so: a display-media handler asks, every time,
in a native dialog listing screens and then windows. Without a handler `getDisplayMedia` just failed,
so the `display-capture` grant had never done anything.

**Smaller holes, same theme:**

- `will-redirect` ignored `isMainFrame`, so any iframe redirecting off the allowlist was cancelled
  and bounced to the browser — a tab opening for something nobody clicked.
- A `file:` custom connection had an allowlist of `['']`, and the empty host matched every `file:`,
  `data:` and `about:` URL. Main refuses non-web custom URLs now, and `isAllowedHost` ignores empty
  entries and accepts only web URLs.
- The blocked page's Allow button carried no argument by design (#94), but the host it meant stayed
  armed after "Back to …", so the service's own script could call `__hangar.allowHost()` later.
  Allow and Try again are honoured only from our `data:` pages now, and the host is forgotten as
  soon as the pane navigates anywhere else.
- `customJs` no longer travels through git sync: anyone who can push to the repo could otherwise run
  script in a signed-in page on every machine that pulls. CSS still travels; it can restyle a page,
  not act as you.
- Export leaves out `pushRegistrations`, which hold the private keys for this machine's pushes.
- "Open when complete" shows scripts, apps and installers in Finder instead of opening — opening one
  is running it, and a page chooses what it downloads.
- Service views and their popups use `safeDialogs`, so a page looping `alert()` can be stopped.

Both e2e tests in `security.spec.ts` were checked by removing the guard each covers: each fails
without it.

## 98. Failing well: bounded retries, logged rejections, screens that come back

A pass over what the app does when something goes wrong, driven by what the log actually showed.

**The reload loop.** Offline, one pane reloaded every second for as long as the network was gone —
627 consecutive failures on a single Teams sign-in URL, 96% of a 1 MB log. The backoff (1s, 2s, 4s,
then the error page) never advanced because `did-finish-load` reset it, and Chromium fires
`did-finish-load` for the error page it commits after a failed navigation. So every failure was
followed by a "success". The count is now forgiven only by a load that stays up for thirty seconds
(`attemptsSoFar`, `HEALTHY_AFTER_MS`), which is pure and has a test replaying the old sequence.
`ERR_INTERNET_DISCONNECTED` no longer retries on a timer at all — retrying while the OS reports no
network cannot succeed — but shows the offline page at once and polls `net.isOnline()` to reload
itself when the network is back.

**Rejections are log lines.** The `unhandledRejection` handler rethrew, which ended in
`showErrorBox`: modal and synchronous, so the main process stopped until someone clicked OK. With the
window closed to the tray there was nobody to click it. A `zoommtg:` link on a Mac without Zoom was
enough. Uncaught *exceptions* keep the dialog — that is our own synchronous code being wrong, and
Electron's behaviour to preserve. The floating promises that were most likely to reject now carry
their own `.catch` with context: sign-out, export, import, push reconnect.

**Ad blocking covered one account.** ghostery registers two global IPC handlers on every session's
enable, and `ipcMain.handle` throws on the second — after marking the session enabled and before
installing its network listeners. The second and later accounts were never blocked, never retried,
and the log said so on every boot. Disabling one removed the handlers for all. The handlers delegate
to the shared engine, so clearing them before each enable and restoring them after a disable is the
whole fix (`adblock-sessions.ts`, tested against a fake that fails the same way).

**The app's own screens recover from crashes.** Service views always reloaded after a renderer
crash; the rail, Settings and the overlays never did, and a dead rail was a blank strip until quit.
`loadRoute` gives them the same recovery, three times a minute at most. GPU and network-service
crashes are logged with their reason and exit code.

**Things that were silently wrong:**

- The global shortcut compared the chord only, so a rebuilt window was told it was already
  registered and kept the old window's handler — or none, once dispose had released it.
- Custom CSS and JS were read from the service as it was when its view was built, so an edit applied
  only after a sleep and wake.
- "System" proxy meant "leave whatever is there", so leaving a work proxy kept it until restart; and
  picking "http" applied `http://:0` before a host was typed, cutting every service off.
- The hibernation sweep's relayout marked pane services read whatever the window was doing, so with
  the window closed to the tray, messages were wiped before anyone saw them. Panes are acknowledged
  on `show` and `restore` instead.
- Removing a service cleared its unread without recomputing the badge.
- Hiding a fullscreen window left an empty black Space; it leaves fullscreen first now.
- "Confirm before quitting" stopped logout and shutdown. `powerMonitor`'s `shutdown` quits without
  asking.

**The log.** It is launchd's `StandardOutPath` and nothing ever rotated it; a Finder launch logged
nowhere; and Electron's own "Failed to load URL" warnings wrote full sign-in URLs into it, email
address and `state` included. It is rotated at boot past 5 MB (copy-and-truncate, because launchd
holds it open in append mode), teed with timestamps for launches whose stdout isn't the file, and
Node's default warning printer is replaced by one that redacts query strings.

Each new E2E test — the crashed rail, unread in a hidden window — was checked against the bug put
back. The first draft of each passed anyway: one polled before the crash happened, the other
triggered a sweep that returns early when hibernation is off. Both now fail without the fix.

## 99. UI that does what it says

The P1 UI findings from the audit, each a control that promised something and didn't deliver it.

- **Folders could not be renamed.** Right-click ▸ Rename… opened Settings, which had no folders, and
  nothing ever sent `rename-folder`. `renameRequest` is now `{ id, nonce }` for any rail item, the
  opened panel edits a folder's name in place exactly as it does a service's, and Settings has a
  Folders section for rails with no room for a field. A new folder asks for its name immediately
  when the rail can edit in place — only then, because elsewhere that would throw Settings open
  every time. `rename-folder` searches every workspace, since Settings lists them all.
- **A reloaded rail reopened the last rename.** Main never clears a request, and the rail seeded its
  "last handled" nonce from state at mount — always null. It now adopts whatever request arrives
  with its first state as already handled. That mattered more once the rail started recovering
  from crashes (#98).
- **Destructive buttons were one click.** Remove, Sign out, Delete workspace, Reset all, Delete
  unused sessions and both sync resolutions are `ConfirmButton`s: the first click arms and relabels
  ("Remove Gmail?"), a second within four seconds acts, and a pause, Escape or leaving the button
  disarms it. Two clicks rather than a dialog: nothing is blocked, and a modal's default button is
  exactly what gets dismissed by reflex. Add, Export, Import and Default were styled `danger` for
  want of anything else and turned red under the pointer; they are `secondary` now.
- **The Add Connection focus trap never engaged.** It attached in a mount-only effect, and the picker
  renders nothing until state arrives — after the first render. A callback ref attaches when the
  element does. The test that shows it fails against the old hook.
- **Number fields clamped per keystroke,** so the "7" of "72" in a field with a minimum of 56 became
  56 on the spot and a rail size could not be typed. `NumberField` holds the text, applies a value
  once it is valid and has settled for 250ms (so the spinner still feels live), and clamps on blur.
- **Allowed hosts were read-only** while two hints said to add them there. Every service now has a
  field for extra hosts, additive over its catalog list; main keeps only valid hostnames, and the
  field showing back what was accepted is the feedback.
- **`~/code/dotfiles` — the placeholder — failed as typed,** and a relative path resolved against `/`
  in a Finder launch. `resolveRepoPath` expands `~` and resolves relative paths from home.
- **The tray, the palette and the rail's spoken count saw one workspace** while the Dock badge saw
  all of them. `allServices` is projected into full views now, those three read it, and
  `focus-service` switches to the workspace a service lives in rather than dropping it into this
  one's panes. The palette labels a service elsewhere with its workspace's name, and is a combobox
  over a listbox so the highlighted result is announced.

## 100. Doing less: broadcasts, cookies and writes only when something changed

Three loops did their full work whether or not anything had happened.

**State broadcasts.** `sync()` sent the whole state to every surface immediately, and it runs on
every page load start and stop, every mutation, and — through relayout — every resize event.
Dragging the window's edge re-rendered the rail, the overlay and Settings sixty times a second with
an identical state, and each broadcast also listed the data folder for quarantined configs. Now
calls within a frame collapse into one, a surface is sent a state only if it differs from the last
one *that surface* received (so a surface that has just opened is never starved), and the
quarantine listing is cached for a minute — it only changes at boot. `state()` is still synchronous
for callers that need it now. An E2E test resizes the window thirty times and counts what the rail
receives: thirty before, at most two after.

**Cookie promotion.** Every minute, every partition had every cookie read and its session cookies
re-written, and its storage flushed — the log shows the same seven cookies promoted over and over.
Promotion only exists for *session* cookies, so each session now marks itself when one is set
(`cookies.on('changed')`), and the minute loop promotes only those; storage is flushed for everyone
every fifth minute. Our own promotion writes persistent cookies, which don't mark anything, so it
cannot keep itself busy. Quit and suspend still do everything.

**Config writes.** Every change was a synchronous copy, write, fsync and rename — every pane focus,
every push message, every step of a drag. Everything reads the in-memory copy, so the disk write
now waits 300ms and a burst becomes one. Quit flushes before `app.quit()`, and a synchronous
`process.on('exit')` flushes for every other ordinary exit; only a hard kill can lose the last 300ms.

Also: the set holding notifications alive for click-to-focus is capped at fifty, because one left
in Notification Center never closes; and React and dnd-kit moved to `devDependencies` — Vite
bundles them into the renderer, so as dependencies they were shipped a second time, unused, inside
the asar. dependency-cruiser's no-dev-deps rule now exempts `src/renderer/` for that reason.

**Not done, on purpose.** Background throttling stays off for service views: the unread probe runs
on a timer inside the page, and throttling would let the count lag by up to a minute. That trade
wants a battery measurement first, not a guess.

## 101. Names, keys and motion

The accessibility findings from the audit, all of them small and all of them the difference between
a control a screen reader can use and one it can't.

- **About fifteen controls had no accessible name**: the global shortcut, the proxy host and port,
  the downloads folder, every workspace, connection and account name field, per-service zoom
  (titled "Zoom" — a title is not a name), the Add Connection search and custom URL/name fields, and
  the find bar's input and its ↑ ↓ ✕ buttons, which a screen reader read as the glyphs. All are
  labelled now, and the glyphs are hidden behind real names.
- **Reordering from the keyboard used a key macOS takes.** dnd-kit's lift is on ⌃Space so that Space
  can open a tile (#25), and ⌃Space is also the default shortcut for switching input source: with
  two keyboard layouts, reordering never reached the rail. ⌥↑/⌥↓ (⌥←/→ on a horizontal rail) now
  moves the focused tile one step without lifting it, and a status region says where it went. The
  handler stops the key even at the end of a list, because a folder member's wrapper is inside the
  folder's and the folder would otherwise move instead.
- **Drag announcements said the wrong thing.** dnd-kit's defaults told you to press Space — which
  opens the service — and named the tile by its id, a UUID. The instructions now give the keys that
  work, and the announcements use the tile's name.
- **Nothing honoured "Reduce motion".** The loading pulse and waking shimmer looped for as long as a
  service was loading. Under `prefers-reduced-motion` every animation and transition collapses to
  its end state; none of them carry information that isn't also shown statically.
- **Two messages were only visible**: the refused-shortcut explanation is an alert now, and the
  find-bar's match count is a status region, read out as it changes.

## 102. The rail and main agree on where the traffic lights are

A compact rail along the top drew the traffic lights over its first two tiles. Main decided they
didn't fit — a 48px rail is under the 52pt span, the test that is right for a *left* rail — and put
them where the top strip goes. But a top rail has no strip above it, so nothing was reserved, and the
rail hid its own spacer for any compact rail on the strength of a comment saying the strip would hold
them. Two places, each deciding from half the facts.

- **One decision, shared.** `railHostsWindowButtons` in `src/shared/chrome.ts` is what main lays the
  window out by and what the rail's spacer is shown by. A top rail always holds the lights: the span
  runs *along* it, so all it needs is the strip's height.
- **A horizontal compact rail doesn't open.** Opening puts names beside the icons, and a top or bottom
  rail has no room beside them — the chevron grew the strip into a 180px band of the same icons,
  flush against the window edge. `railCanExpand` refuses it in main and hides the chevron in the
  rail, and `railSizes` ignores the flag, so one left over from a side rail can't do it either.
- **The real button size.** macOS 26 draws the traffic lights larger — 14pt buttons in a 60pt span,
  not 12pt in 52pt — and Electron doesn't report it. Laid out for the old size they sat 10pt from a
  left rail's edge and 2pt from the other. Main picks the metrics by OS version.
- **The window's background follows the theme.** It shows wherever no view is drawn — the strip
  holding the traffic lights, the gutters between panes — and was fixed dark, so a light theme had a
  black band across the top of a light rail.
- **Horizontal rails were unfinished**: the first tile sat flush against the window's rounded corner,
  and the focus bar, drawn in the margin outside the tile, was clipped by a container the height of
  the tile — a top or bottom rail showed no focus at all. On a bottom rail it now faces the content,
  as the side rails' bars do.

## 103. Being on screen doesn't read a count the page reported

Relayout marked every visible pane read, and so did showing the window. That is the only signal
there is for a count we tally from notifications — but a page that draws its own badge reports only
when the number *changes*. Clear its 3 because the pane was on screen and it stays at 0 while Gmail
still says 3, until the next message moves it. At launch it raced the first report, which is how the
badge test failed one run in five.

`AttentionCenter` remembers which services' counts came from the page (a DOM rule, a title pattern,
an endpoint), and passive acknowledgement — relayout, show, restore — leaves those alone. Marking a
service read by hand, muting it or changing its rules still clears everything, and forgets where the
count came from so the next report starts afresh.

## 104. Keeping PR #3 honest: a Start page that stays, a quit that can't hang, a drag main can't end

Four things the Phase 8 review found, fixed before the branch merges.

- **Start pages were erased on every launch.** `migrateConfig` dropped `url` from every catalog
  service — correct when only older builds wrote it, as copies of the catalog's URL that went stale
  with the next catalog fix (#48's Notion). Settings → Connections now sets it on purpose, and the
  next launch put a self-hosted GitLab back on gitlab.com. Config v5 makes the strip a migration:
  a pre-v5 file loses the field, since no earlier build could have written a choice that survived a
  relaunch, and from v5 only a value identical to the catalog's goes.
- **A quit could stop halfway.** `quitGracefully` flushes the config and then calls `app.quit()`,
  both inside a `.finally`; a throw from the flush skipped the quit and left the app half-quit —
  the Force Quit #96 exists to prevent. The flush is guarded now.
- **The E2E suite couldn't say why the app wouldn't quit.** CI reported a sync test as a 60-second
  hook timeout and nothing else. The harness now keeps the app's own output, bounds a quit at 15
  seconds and kills it, and prints that output when a test fails. Under the harness a fatal error
  logs and exits rather than raising a modal nobody will click. Scratch directories are deleted with
  retries, because a `git` the app started can outlive the app for a moment.
- **A rail drag no longer involves main until it leaves the rail.** Telling main at the lift
  attached the drag layer for every reorder and every drop onto a folder, and anything that relaid
  the window out mid-gesture ended the drag from outside: the folder test's intermittent CI failure.
  Now the rail hands a drag over only when the pointer crosses its edge, and main logs why any drag
  it ended stopped.

Also: density renders as `density-*`, not `is-*`. Its value `compact` produced `is-compact`, which is
the collapsed compact rail's class, so a 72px rail on compact density took on every compact-rail
rule.

## 105. Phase 8 polish: one set of colours, and the keyboard goes where you went

The review's small findings, fixed together because most were one cause showing up in several places.

- **Colours are tokens, each with a light value.** The palette's highlight, `kbd`, chord buttons,
  danger and focus colours were hex literals written for the dark theme; in light they read at
  1.2–1.4:1. Three variables used throughout (`--text`, `--surface-hover`, `--accent-strong`) had
  never been defined, which is why the opened panel's names were in brand colours. Native controls
  now draw in the theme too, via `color-scheme` on the controls and scrollers — not the root, which
  would paint the canvas of the transparent overlay and find-bar views.
- **Service colours are adjusted for the tile they're on.** `brightenForDark` only lifted, and
  every surface used it in both themes, so a colour made for white was washed out on a light tile.
  `accentFor(colour, scheme)` darkens on light, reads the `hsl()` every custom connection has, and
  lives in `shared/` so the pane's focus ring — the raw brand hex until now, invisible for GitHub,
  X, Threads and Slack — uses it as well.
- **Switching moves the keyboard.** Every route to a service now ends by focusing its pane, except
  a tile activated from the keyboard, which keeps focus in the rail (`keepFocus`, from a click with
  `detail` 0). Before, typing after ⌘K↵ or ⌘3 went to whatever had focus last.
- **⌘R and ⇧⌘R** reload the focused service. A pane isn't a browser tab and nothing had given it
  the chord.
- **A wholesale change runs its effects.** Sync and import replace preferences without
  `set-preference`, so theme, tray, shortcut, ad blocking, push and spellcheck used to wait for a
  restart. `effectsForChange` diffs the two and returns what to run.
- **A banner's click is routed by boot**, which can build a window, instead of by the window that
  raised it — after ⌘W that window was destroyed, and the click threw on it.


## 106. Engineering health: what the linter, the bundle and the broadcasts were hiding

- **`tsc` can't see a promise nobody awaits.** ESLint now runs type-aware, with
  `no-floating-promises` and `no-misused-promises` for exactly that — a rejection with no handler,
  an async function passed where a void callback was expected — and React's hook rules beside them.
- **The renderer was 831 KB, unminified, and one chunk loaded by six views.** It is minified now
  and split per route. **The drag layer and the find bar stay in the entry chunk.** Lazy-loaded,
  the drag layer missed the first highlight: main sends it the moment the view exists, before a lazy
  component is listening. A CI check guards the size.
- **One theme source.** `shared/theme.ts` holds the window, text and tile colours that main paints
  and the stylesheet uses. A test checks that the two agree.
- **The config is snapshotted once per launch** (`config.launch.json`). A round-trip test covers
  every key, since `migrate` drops keys it doesn't know.
- **Broadcasts no longer carry scripts.** Custom JS and CSS go to the Settings window, which edits
  them, and nowhere else.
- **Push has a generation counter.** A `connect()` still in flight after `stopAll()` gives up at
  its next `await` instead of opening a socket nobody owns.
- **Each Vitest worker gets its own `userData`.** They had shared one directory, which was the
  likely source of the one-off flake.

## 107. Everyday UX: a command palette, services that keep running, one page per service

- **⌘K is a command palette.** It lists every keymap action by its menu name, plus verbs for the
  focused service, recent services first. The keymap table already had each action's label and
  command for the menu, so the palette is a third reader of it rather than a second list.
- **Keep running is opt-in per service.** It means loaded at launch and exempt from hibernation,
  so the service notifies without a pane. A view with no bounds still runs; it just draws nothing.
- **The accent is chosen by the stylesheet, not a listener.** `accentStyle` sets both variants,
  `--accent-dark` and `--accent-light`, and a media query picks one. Picking in JS went stale
  whenever the theme changed without an event reaching the renderer, as it does under emulation.
- **Badge only** is a notification level between All and Off: counted, never a banner. It
  merged the mute flag and the notifications toggle into one setting.
- **A pane's edges open beside it** (`edgeZone`, a quarter of the pane up to 120px). "Open
  alongside" used to be only the 6px gutter, so with one pane it was unreachable.

## 108. A colour token defined as itself

The pass that replaced literal colours with tokens (#105) was a find-and-replace, and it also hit
the definitions: `--focus: var(--focus)` and `--danger: var(--danger)`. A custom property that
refers to itself is invalid at computed-value time, so every property using it falls back to its
initial value. In the dark theme that removed the focus outlines, the drop target's border and the
red of destructive buttons.

Nothing reported it:
- There was no console error.
- axe passed: a lost text colour inherits a readable one.
- The screenshots were looked at for layout, not for those three details.

It was found by reading the stylesheet while adding the splitter's line.

`tests/renderer/tokens.test.ts` now fails on any token that refers to itself, and on any token
that is used without being defined.

## 109. Splitters: a view per gutter, screen coordinates, and nothing re-attached mid-drag

- **A gutter has nothing to take a pointer.** It is bare window background, and a `View` has no
  mouse events. So each boundary gets a thin transparent `WebContentsView` (`features/splitters.ts`).
  Views are pooled, not closed, when columns drop: one closed while its page was still loading
  logged a failed load.
- **The drag reports `screenX`.** The splitter's view moves with the boundary it is dragging. A
  client position is measured from where the view was when the event was made, a frame earlier,
  and main is moving it every frame. That is a feedback loop.
- **Nothing re-attaches a splitter mid-drag.** macOS sends the rest of a press to the view that
  received the mouse-down. `relayout` re-adds every pane on top, so splitters have to be raised
  again, but only when a pane is actually above one (`raiseAbove`). The drag itself takes a fast
  path that only sets bounds.
- **The minimum width gives way in a narrow window.** No pane is dragged under 280px. But three
  columns in 820px are 240px each already, and a floor of half the pair pinned every boundary in
  place. The floor is now a third of the pair when 280px can't fit.
- **The z-order test needed a second relayout to mean anything.** After the first relayout the
  splitter sat above the panes only because it was created after them. With the raise removed, the
  test still passed until it relayouts before checking.

## 110. `hangar://` links: a link is never a command

Any page can open a `hangar://` link: a browser, a mail, a service Hangar is showing. So
`core/runtime/deeplink.ts` parses a link into one of seven verbs and builds commands from fixed
templates. Nothing from the link reaches `dispatch` except a name to look up. A test runs hostile
links through it and checks that only eight command types ever come out, and that the one patch it
can produce is a mute.

- **Flags are rewritten as links and parsed once,** so the two grammars can't drift apart.
  A second launch hands them to the running copy in `requestSingleInstanceLock`'s
  `additionalData`, the way `--quit` does. Chromium rewrites the forwarded argv; `additionalData`
  is ours.
- **Only asking to see something brings the window forward.** `open`, `workspace` and `show` do.
  A Focus automation turning on Do Not Disturb doesn't.
- **A service is found by name before catalog entry.** With two Gmails, `gmail` means either one;
  the name is what the user chose.
- **An unpackaged build never registers the scheme.** Doing so from `npm run dev` would make
  Electron itself the handler for `hangar://`.

## 111. Pane bars: their own channel, tucked under the page, and a drag that moves the pane

- **Title bar and headers get a channel of their own** (`pane-chrome:state`), not `ShellState`.
  A page's title changes whenever a chat app's count does, and the rail, the overlay and Settings
  would have re-rendered for each change.
- **A header runs `PANE_RADIUS` under its page** (`splitCard`). Electron rounds every corner of a
  view alike, so a header exactly its own height pinched where its rounded bottom met the page's
  rounded top.
- **The title bar paints the window's colour instead of staying transparent.** It's the same
  picture on screen, but axe measured the text against white and failed it in the dark theme.
- **A title loses its count, and is dropped when it only repeats the name.** "(3) Slack" beside
  "Slack" says nothing; the rail already shows the count.
- **Dragging a pane reuses the tile drag.** It uses the same frozen geometry, layer and highlight,
  with a pane in flight instead of a service, and a drop that moves the pane.
  - "A new pane" is always offered, even with four open, because moving a pane doesn't add one.
  - Dropping a pane on itself, or beside itself, does nothing and draws nothing.

## 112. The tile you're looking at is the one colours were never checked against

Service colours and `--muted` were both tuned against `--tile`. The tile you're actually looking
at is `--tile-focused`, which is also what a hovered picker tile uses. It is the extreme of the
ramp: lighter in the dark theme, darker in the light. There, Slack's initials made 4.03:1, and the
picker's sub-text 4.26:1 (dark) and 4.02:1 (light).

Only CI's axe run caught it, and it caught it every time. Locally it depended on where the real
pointer happened to be over the window.

- `accentFor` now clears every tile state, not just the plain one.
- It also judges contrast after rounding to whole channels. Before rounding, a colour could clear
  4.5:1 by a hair and come out of `toHex` just under it; Google Slides did.
- `--muted` moved to #9c9ca4 (dark) and #54545d (light).
- Tests hold every catalog colour, and `--muted`, to 4.5:1 on each tile shade in both themes.

The same run's drag failures were a race of their own. Main sends a drag's first highlight as
soon as the layer's view exists, which on a slow machine is before its page is listening. Now the
layer asks for the current highlight once it is listening.
