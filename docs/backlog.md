# Backlog — what isn't done

Everything Hangar doesn't do yet, why, and what it would take. Categorised by **the kind of
blocker**, not by feature area, because that's what determines whether something is a decision, a
purchase, or an afternoon.

Last updated after **Phase 7** (2026-09-26): the installed app ran with no reachable window, which
led to removing `startHidden`, fixing the Dock and tray routes back, and a one-command signed local
install — [decisions #96](decisions.md). A full audit of what remains is **§13**; it supersedes the
older lists below wherever they overlap.

Before that, **Phase 6** (stability audit: config-sync lifecycle, teardown, renderer split), plus
the long-running work: crash resilience, waking from sleep, and launch at login without a signature.

**Test counts are deliberately not written here.** They drifted three times — this page once claimed
327 in one place and 262 in another while the suite ran 392, then said 700 while it ran 690. Run
`npm run check` for the unit total and `rg -c '^test\(' e2e/*.spec.ts` for the end-to-end one. A
number in prose is a number nobody updates.

Phase 4 closed everything in the old §1.4 and most of §2 — including a P0 that destroyed the config
when you removed your last service, and the discovery that **Web Push had never worked for the case
it was built for**. See [decisions.md](decisions.md) #47–63 for the findings.

---

## 1. Blocked on something outside the code

Can't be finished by writing more of it. Each needs a purchase, an account, or an upstream change.

### 1.1 Code signing — $99/year Apple Developer Program

Two things depend on it. **Launch at login used to be a third and no longer is** — it now goes
through a user LaunchAgent, which macOS does not gate on a signature ([decisions #93](decisions.md)).

| Blocked | Detail |
| --- | --- |
| **Giving the DMG to anyone else** | An unsigned, un-notarised DMG shows "damaged and can't be opened" on another Mac. The message is a lie — it means unsigned — but the recipient can't tell. |
| **Auto-update** | Deliberately not configured (`publish: null`). An updater on an unsigned build is a mechanism for delivering someone else's binary to your users. Needs signing *and* notarisation first, not as a follow-up. |

**To do it:** enrol, add the certificate to the keychain, run `npm run dist:signed`, then add a
`notarize` step with an app-specific password. The config is already shaped for it.

For your own machine none of this matters — right-click → Open once and it behaves normally.

### 1.2 Web Push needs your own Firebase project

FCM web registration requires `apiKey`, `appId` and `projectId`; Google decommissioned the
sender-id-only path, so anonymous registration no longer exists. Hangar can't embed a project — the
key would sit in the repo, on one quota, revocable for everyone by any single user's abuse.

**Status:** fully built, off by default, four fields in Settings. Free tier, ~3 minutes.
See [push.md](push.md).

**This is the only feature in Hangar with a setup step.** If that's unacceptable, the alternative is
registering a Hangar-owned project and accepting the shared-quota risk — a real option, just not one
to take silently.

### 1.3 Two upstream limits in the push receiver

Both in `@eneris/push-receiver`, not fixable locally:

- **Only `aesgcm` (draft-03) decrypts**, not RFC 8291's `aes128gcm`. Sites on the newer scheme have
  their pushes dropped with a warning. Increasingly common — this is the more serious of the two.
- **Payloads are `JSON.parse`d unconditionally**, so a site sending plain text throws inside the
  receiver and the message is lost.

**To do it:** patch upstream, or vendor a fork with a fallback path. Worth measuring first — find
out which of your services actually use `aes128gcm` before spending on it.

---

## 2. Built but not verified end to end

Written, typechecked, unit-tested where the logic is pure — but never proven against the real thing.
Listed separately from "done" on purpose.

| Item | What's unverified | How to check |
| --- | --- | --- |
| **Web Push transport** | *Delivery to a sleeping service is now verified* by injecting a synthetic payload — it was broken, and is fixed. What remains untested is FCM registration, the MCS socket and real decryption. | Configure Firebase, hibernate Slack, DM yourself. |
| **Find in page** | Wired and now closes correctly when focus moves, but never driven against a real page. | ⌘F in Gmail, check the match count and ↑/↓. |
| **DMG install flow** | The app was launched from `dist/mac-arm64/` directly, never installed from the mounted DMG to `/Applications`. | Mount, drag, launch, confirm icons still resolve. |
| **Salesforce session survival** | Known to have failed earlier in the project; `sessionNotPersistable` exists for it but the fix wasn't re-confirmed after the durability work. | Sign in, quit, relaunch. |
| **Long-run hibernation** | Never observed over hours. The 30-second sweep and wake path work in a short session. | Leave it running a day with `hibernateAfterMinutes` set. |

---

## 3. Deliberately not built

Decisions, not omissions. Revisit if the reasoning stops holding.

| Not built | Why |
| --- | --- |
| **Nested folders** | One level deep. Past that is where Arc-style sidebars stop being navigable. |
| **"Mentions only" notifications** | Would mean inferring a mention from a title string. A filter that silently drops real messages is worse than no filter. |
| **Auto-update** | See 1.1 — needs signing first. |
| **Per-service proxy** | Global only. Per-service means per-session proxy config and a much larger surface for "why won't this load". |
| **Windows / Linux builds** | The whole layout story is `trafficLightPosition`, `titleBarStyle: 'hidden'` and macOS window buttons. Porting is real work, not a config flag. |
| **Containerisation** | A container moves a process whose interface is a socket. This one's interface is a screen, a keyboard, a notification centre and a microphone. What you'd get is the Linux build in a VM behind VNC, minus the tray, notifications, calls and sleep handling — on Windows and macOS that VM is running on the machine that could have run the app. Electron already is the portability layer; native builds are the cross-OS answer if one is ever wanted. |

---

## 4. Features not yet built

Wanted, unblocked, just not done. Roughly in value order.

### 4.1 Interaction

- ~~**Drag a tile onto a pane**~~ — built. Was filed as impossible on the strength of
  [decisions #10](decisions.md); the way through was to stop letting renderers decide anything, and
  is written up as [decisions #86](decisions.md).
- ~~**Drag a service into a folder**~~ — built. Members are rows of the same sortable list as the
  top level, so a service drags in and out; the right-click `Move to folder ▸` stays for keyboard
  and precision use.
- ~~**Compact rail hover-expand**~~ — built. The sliver stays 48px as far as the panes are
  concerned and grows *over* them under the pointer, which needed the rail ordered in front of the
  panes — see [decisions #88](decisions.md).
- **Wake-on-click affordance for sleeping tiles** — a sleeping tile is 50% opacity and a tooltip.
  Nothing says "click to wake", so it reads as broken rather than asleep.

### 4.2 Settings

- ~~**Reset to defaults**~~ — built, per section and globally, so a bad rail position or zoom no
  longer means editing `config.json` by hand.
- ~~**Keyboard rebinding**~~ — built, with conflict detection and the per-service passthrough list
  that lets Slack keep ⌘K for itself. What had blocked it was not the UI but a second copy of the
  chord living in the menu, so a rebind changed one and not the other — [decisions
  #89](decisions.md).
- ~~**Notification level per service in the UI**~~ — built, as a `mute` checkbox in Settings →
  Connections beside `hibernate`. `update-service` gained validation at the same time: it was a
  bare `Object.assign`, so `notificationLevel: 'quiet'` would have persisted happily. See
  `core/services/patch.ts`.

### 4.3 Accessibility

Still the weakest area, though no longer bare. Overlays are `role="dialog"` with a focus trap
(`useFocusTrap.ts`), Settings controls pair `<label htmlFor>` with `aria-describedby`, folders carry
`aria-expanded` and a `role="group"`, the rail has a live region for drag announcements, and
`:focus-visible` gives a visible ring.

What is genuinely missing:

- The folder tree isn't announced as a tree — no `role="tree"` / `treeitem`. Partly deliberate: full
  tree semantics commit to arrow-key navigation the rail doesn't implement.
- Panes have no landmark roles, so there's no way to navigate between them with a screen reader.
- **No VoiceOver pass has been done.** Everything above is markup that looks right, which is not the
  same as usable, and there are still no accessibility tests.

**To do it:** pane landmarks first, then an actual VoiceOver pass. It's the thing most likely to be
embarrassing if anyone else uses this.

---

## 5. Testing gaps

Vitest plus `dependency-cruiser` on every run. The pure-module architecture is what makes that
possible: `shell-state.ts` and `migrate.ts` were extracted from `app-window.ts` and `config.ts`
specifically so their logic could be reached, and `effects.ts` for the same reason — "does changing
the API key restart push?" was a question you could only answer by running Electron.

A score of them skip when `git init` can't create `.git/hooks`, which is the case in a sandboxed
shell. They skip with a reason rather than failing; a red suite for a reason unrelated to the code is
how real failures get ignored.

What it still doesn't cover:

- **Most of what needs a real window.** Pane geometry, relayout ordering and view attachment are
  reachable only through Playwright, and the E2E suite covers the paths that have broken before
  rather than the surface as a whole.
- **`app-window.ts` has grown to nearly 2,000 lines**, and its Electron-coupled half — `relayout`,
  `openService`, `dispatch`'s side effects — remains untestable without a real window. It has roughly
  doubled since this entry was first written, which is the point: extracting pure logic has kept the
  *tested* share up without shrinking the file.
- **No accessibility tests at all**, which is the gap behind §4.3.

**Highest value next:** pane landmark roles and a VoiceOver pass, now that the probe-to-Playwright
migration is done.

---

## 6. Enhancements not yet built

**Catalog expansion.** 55 entries against Rambox's ~700 and Shift's ~1,500. Each is ~8 lines plus a
vendored icon; the real cost is curating `allowedHosts`, and getting one wrong sends the service's
own URL to the system browser. `catalog.test.ts` now asserts every entry allows its own URL, so the
expansion has a safety net. Target ~60.

One rule learnt from doing it: **do not delete an entry to fix it.** A `catalogId` that stops
resolving strands every existing instance on `about:blank` with every navigation refused and nothing
saying why. Entries that cannot work — Signal has no web client, Obsidian's vault is local — carry a
`caveat` shown in the picker instead. `isOrphaned` covers the case anyway, for anything renamed or
removed later.

**Ad and tracker blocking.** *Done* — `@ghostery/adblocker-electron` in `main/platform/adblock.ts`,
per session in `sessionFor`, engine serialised to disk, `network.blockAds` to turn it off. See
[preferences.md](preferences.md) for the measured costs.

**Startup performance.** V8 snapshots cut Atom's startup ~50%. Worth measuring now that the module
boundaries make the main bundle's dependency graph legible.

---

## 7. Known behaviours worth writing down

Not bugs; things that will look like bugs later.

- **The site's service worker never sees a push.** Hangar notifies from main instead. Anything the
  worker would do beyond showing a notification — syncing read state, in-page badging — doesn't
  happen.
- **One socket per push-enabled service.** A registration is bound to its VAPID key, so they can't
  be pooled. Five services means five connections to `mtalk.google.com`. This is why push is
  per-service rather than global.
- **Unread clears by looking, not by dismissing.** Matches the underlying web apps and is the only
  signal we reliably have.
- **A sleeping service's count comes from a background request.** Only for services with an endpoint
  rule, only on that service's own hosts, and only over the login it already has
  ([decisions #91](decisions.md)). A service you keep open is never called.
- **`hibernateAfterMinutes` defaults to 0 (never).** Hibernation is opt-in; the memory saving is
  real but so is the cost of a cold load.
- **The tray shows a count as text, not a badge.** macOS trays have no badge API.
- **Icons load asynchronously** and take a second or two to populate on a cold start. Tiles show
  initials until then.

---

## 8. Suggested order

If picking this up fresh: §13 is mostly closed, and what remains in it is listed there with the
reason each is open — `CommandRouter` (§13.6) is the one worth doing first. Then:

1. **Fill in unread selectors** — the DOM mechanism ships ([decisions #90](decisions.md)), with
   rules for Salesforce and GitLab and a per-service field for the rest. Notion, Jira, Confluence,
   Trello, Asana, ClickUp, Monday and Figma each need one afternoon with the page open, following
   [unread-selectors.md](unread-selectors.md).
2. **Accessibility: pane landmarks and a VoiceOver pass** (§4.3) — cheapest real quality win, still
   the weakest area, and the only one with no tests behind it.
3. **Verify the unverified** (§2) — an afternoon with a checklist, no new code.
4. **Code signing** (§1.1) — a purchase decision; unblocks distribution and auto-update.

---

## 9. What Phase 4 fixed

Kept for context on where the remaining gaps sit. Full reasoning in
[decisions.md](decisions.md) #47–63.

| | Was |
| --- | --- |
| **P0 data loss** | Removing your last service wrote `services: []`, which the loader treated as corruption — quarantining the config and falling back to a backup the next window-move had already overwritten. Defaults were then written over everything, replacing all accounts and partitions. |
| **Web Push never worked** | `handleNotification` bailed on a missing runtime, and a hibernated service has no runtime *by definition*. Every push the feature existed to deliver was decrypted, deduplicated, marked consumed and discarded. |
| **Unread died on hibernate** | The count lived on the object holding the view, so sleeping a service reset it. |
| **Close-to-tray silenced the front pane** | Visibility was pane occupancy alone, with no `isVisible()` check. |
| **⌘W broke the app** | Nothing disposed the old window: global shortcut, tray, Settings and push sockets all kept dead references, and detached views leaked ~100 MB each. |
| **Import bypassed migration** | `saveConfig({ ...parsed })` with no defaults or versioning wrote invalid config straight to disk. |
| **Every custom tile lost its accent** | `brightenForDark` returned `#NaNNaN14` for the `hsl()` colours `colorForHost` generates — invalid CSS, silently discarded. |
| **No version control** | 7,261 lines, no git. |

---

## 10. Typechecking the tests — done

`npm run check` now runs `tsc` over `tests/` as well, via `tsconfig.test.json`. That config extends
the root one and relaxes exactly two rules: `noUncheckedIndexedAccess` and `noImplicitAny`. Both are
right for `src/` and pure friction in tests — `panes[0]!.id` on an empty array should fail as a
*test*, not as a compile error. Everything else stays strict, which is the point: what this catches
is drift between a test and the code it tests.

193 errors → 0. Most were literal widening in fixtures ported from the untyped `.mjs` suites, and
the rest were `.find()` results and partial stand-ins for `Config` or `WebContents`.

Worth recording *how*: two attempts to clear them with a regex produced unbalanced parens that broke
a working suite. What worked was a script driven by **tsc's own line and column numbers** — the
compiler already knows exactly where the problem is, so there's no pattern to get wrong. The last
two dozen were done by hand.

---

## 11. What Phase 5 closed

| | |
| --- | --- |
| **Renderer audit** | Never done before. Five bugs, worst of which: **drag was broken on two of the four rail positions** — the axis modifier was hardcoded vertical while top/bottom rails run as a row. |
| **Accessibility** | Was 2 `aria-label`s and zero roles. Now a focus trap with restore, dialog semantics, `aria-expanded`, labelled groups, a live region, and a visible focus ring. Deliberately *not* `role="tree"` — see [decisions #69](decisions.md). |
| **E2E** | 8 Playwright tests replacing ~300 lines of `console.log` probe. Each verified by reintroducing its bug. |
| **Catalog** | 9 → 37 services. Exposed a live bug: **Notion moved from `.so` to `.com`** and the shipped allowlist didn't cover the redirect, so it opened in Safari. |
| **Config sync** | Git-backed, allowlist of what travels, conflicts never auto-resolved. Three bugs found only by testing two real clones. |
| **Reset to defaults** | Per section and globally. |

---

## 12. What Phase 6 closed

A stability audit rather than a feature phase: eleven defects reachable by ordinary use, four latent
ones hardened with tests. The one worth naming is the first.

| | |
| --- | --- |
| **Two config syncs, one repo** | ⌘W destroys the window and a dock click builds a new `AppWindow` with a new `ConfigSync`. The mutex was `this.running` — correct within one instance, absent across two — so both could run `git` against the same repository and fight over `index.lock`. The mutex is now module-level, and `dispose()` cancels the armed debounce that `unref()` never stopped. |
| **Teardown was partial** | `findBar.close()` threw `removeChildView` on an already-destroyed window, skipping the rest of dispose. The overlay and find bar cache their view and only detach on close, so a closed one was a detached renderer the window never collected. |
| **Duplicate detection read one workspace** | The `+` picker asked `services` rather than `allServices`, so a Gmail added in another workspace offered a second account instead of focusing the one that exists. |
| **Typing was clobbered by broadcasts** | `CommitOnBlur` re-synced its draft on every `value` change, and `value` comes from ShellState — a sync tick mid-word reverted the field and then committed the reverted text. |
| **A page could crash the main process** | `__hangar.notify(null)` reached `handleNotification` verbatim; reading `.title` threw inside an `ipcMain.on` handler, where nothing catches it. |
| **An orphaned account was caught only by sync** | `validateIncoming` refused a service naming a missing account; `migrateConfig` — the path load and import share — did not. The failure surfaced weeks later as being signed out of everything, because it killed the `persistAll` loop that promotes session cookies. |
| **Unlabelled preferences** | Every control in Settings was an unlabelled input: the name was a sibling `span`, so VoiceOver announced forty bare checkboxes and clicking a name did nothing. |

### Still open

- **`app-window.ts` is close to 2,000 lines.** Its pure logic is extracted and tested; the
  Electron-coupled half still needs a real window, which is what the E2E suite now covers.
- **Unread selectors for the eight services that could have one.** The mechanism is done; the
  selectors are not, and are deliberately not guessed ([decisions #90](decisions.md)). The
  procedure for finding one is written up in [unread-selectors.md](unread-selectors.md) — what is
  left is the sitting-with-DevTools part, which needs a real logged-in account per service.
- **Service APIs** — blocked on a decision rather than on code: an OAuth client secret an
  open-source binary cannot hold, or somewhere to keep a personal token that git sync will not
  publish ([decisions #91](decisions.md)).
- **V8 snapshots** — measure first; startup may already be fine.
- **Developer ID signing** — ruled out. Homebrew ended support for casks failing Gatekeeper on
  **1 Sept 2026**, so a cask is no longer a signing-free distribution route. (Local builds *are*
  signed now, ad-hoc or with a self-signed certificate — [packaging.md](packaging.md).)

---

## 13. Phase 7 audit (2026-09-26) — what is still open

A read-through of main, preload, renderer, packaging and docs, done after the reachability fix
(#96). Each item names where it lives and what the fix is. Severity: **P1** is wrong behaviour or a
hole a page can reach; **P2** is cost, polish, or latent. Nothing in this section is fixed yet.

### 13.1 Security (P1) — closed

All of it, in [decisions #97](decisions.md): the internal screens are locked to the app's renderer
and IPC answers only their frames; `openExternal` takes an allowlist of schemes and a rate limit;
subframe redirects are left alone; permissions are judged per requesting frame and re-read per
request; screen sharing works, through a picker; `file:` custom connections are refused in main;
the blocked page's Allow can't be pressed by the page; `customJs` stays out of git sync; exports
drop push keys; "open when complete" won't run a program; service views use `safeDialogs`.

Deliberately kept: **Toggle Developer Tools stays in the View menu** of the packaged app. Finding an
unread selector (§8, [unread-selectors.md](unread-selectors.md)) is done with DevTools open on a
real signed-in page, and this is an app you build for yourself.

### 13.2 Reliability (P1) — closed

All of it, in [decisions #98](decisions.md): ad blocking covers every session; the offline reload
loop is bounded and "no internet" reloads by itself when the network returns; an unhandled
rejection is a log line, not a modal dialog; the app's own screens recover from a renderer crash
and child-process crashes are logged; the global shortcut survives a rebuilt window; custom CSS and
JS apply on reload; the proxy reverts to System and a half-filled manual proxy no longer cuts the
network; unread survives a hidden window and the badge follows a removed service; hiding a
fullscreen window leaves fullscreen first; the log rotates, is written for Finder launches too, and
Electron's own warnings have their query strings removed; logout no longer stops on the quit
confirmation.

### 13.3 UI bugs (P1) — closed

In [decisions #99](decisions.md): folders rename in place in an opened panel, from a Folders section
in Settings otherwise, and a new folder asks for its name straight away; a reloaded rail no longer
reopens the last rename; destructive buttons in Settings take two clicks and the harmless ones stop
looking dangerous; the Add Connection focus trap engages; number fields can be typed into; allowed
hosts are editable for every service; the sync path expands `~`; the tray, the palette and the
rail's spoken count see every workspace, and focusing a service elsewhere switches to it; the
remove dialog says what removal does.

### 13.4 Performance (P2) — mostly closed

In [decisions #100](decisions.md): state broadcasts are coalesced and sent only where they changed
(30 → ≤2 for a resize storm, with a test); the quarantine listing is cached; cookie promotion runs
only for partitions that gained a session cookie; config writes are debounced and flushed on quit
and exit; the live-notification set is capped; React and dnd-kit are build inputs, not shipped
dependencies.

Still open, deliberately:

- **Background throttling stays off** on service views. Throttling an off-screen view slows its
  timers, and the unread probe in the service preload runs on one — the count would lag by up to a
  minute. Worth measuring the battery cost before trading freshness for it.
- **Visible panes still don't hibernate while the window is hidden.** Doing it would make every
  show a reload of whatever was on screen.
- The overlay, find bar and drag views are kept after first use on purpose: they are reused, and
  rebuilding one per open would cost a renderer load each time.

### 13.5 Accessibility (P2) — closed

In [decisions #101](decisions.md): every input and glyph-only button has an accessible name; the
tiles reorder with ⌥ and an arrow, and drag announcements use names and the real keys; the palette
is a combobox over a listbox (#99); `prefers-reduced-motion` stops the looping animations; the
refused-shortcut message is an alert and the find-bar count is a status region.

Still open from §4.3: pane landmark roles, and a real VoiceOver pass — both need the app running
under VoiceOver rather than more code first.

### 13.6 Structure (P2) — started

`AttentionCenter` (`window/attention.ts`) now owns unread, banners, the badge, push delivery and the
recent list, behind a seven-method host interface. `app-window.ts` is ~2,300 lines and still has
the ~650-line `dispatch`. The rest of the split, along the seams it already has: `CommandRouter` (a
handler map, input schema-validated — the next one worth doing, since `dispatch` is most of the
file), `WindowController` (bounds, show/hide, focus ring), `PaneController` (relayout, open,
sleep), `PreferenceEffects`, `TileDragController`, and a scheduler for the timers in
`boot/index.ts`.

### 13.7 UI/UX enhancements — mostly done

Shipped: first-run starters and a nothing-open list (empty view); a ⌘/ shortcut sheet; shortcut
hints read from the live keymap; tile tooltips with ⌘N and ⌥-click; 99+ badges and a sleeping mark;
a workspace switcher in the rail; tile menu Mark read / Mute ▸ / Copy address / Move to workspace /
Open in separate window; timed DND; a picker with alias search, no-results, Enter and arrow keys;
Settings in groups with search, per-service start page / colour / TTL / UA / CSS / JS, About with
real paths, folder pickers, a recorded global shortcut with status, and rows that say when they do
nothing; maximise-pane (⌘⇧↵) and a focus ring. Decisions #99–#101 and the commit log carry the
detail.

Not done:

- **Resizable splitters, pane headers, drag-to-swap panes.** Layout is still columns or 2×2 with
  equal cells. Ratios would live in `Layout` and persist with the layout; headers need a view per
  pane in the chrome.
- **Import from Rambox or Ferdium.** Rambox 2 keeps services in its account and in browser
  storage, not in a file (its `Settings.json` has only app settings); Ferdium keeps them in SQLite,
  which needs a native dependency. Worth doing against a real export, not a guessed format.
- **A per-service loading splash.** The tile's pulse says "waking"; the pane itself is blank until
  the first paint.
- **Undo toasts.** Destructive actions confirm instead (two-click buttons, #99).
- **A "blocked host" toast.** Not needed: the blocked page already offers Allow in the one case
  that matters (a sign-in step), and an external link opening in the browser is not a failure.
- **Spelling languages.** The preference and its effect exist, but `setSpellCheckerLanguages` is a
  no-op on macOS — the system spellchecker picks the language — so a control would do nothing here.

### 13.8 Capabilities — mostly done

Shipped: link routing to the service a link belongs to (opt-in); Hangar as the default email app,
composing in Gmail, Outlook or Yahoo; notification history in the tray; pop-out windows; a
downloads list; self-hosted variants through a per-service start page (which brings its host with
it).

Not done:

- **Browser extensions.** `session.loadExtension` exists, but Electron implements only part of the
  extension API and not native messaging, which is how 1Password and Bitwarden talk to their
  desktop apps. The popular ones would load and not work.
- **Several tabs within one service.** A service is one view today; this is a data-model change
  (a service owning an ordered list of views) through the pane, rail and hibernation code.
- **Quiet hours per service, and scheduled workspaces.** Timed mute (#99-era) is the mechanism;
  a schedule is a recurring version of it evaluated on the same 30-second sweep.

### 13.9 Catalog — done for now

`cloud.microsoft` on every Microsoft 365 entry, with a test; 19 new entries (Google Messages and
Voice, Webex, YouTube and YouTube Music, Threads, Mastodon, Bitbucket, Azure DevOps, HubSpot,
Intercom, Front, Canva, iCloud / Yahoo / Zoho / HEY / Tuta mail, Microsoft 365); `aliases` for
search. The new entries have no vendored icon yet (they capture a favicon on first load) —
`npm run icons` with slugs added, from a machine with network. Monday and Loom still have no icon
upstream, and unread selectors for Notion, Jira, Confluence, Trello, Asana, ClickUp and Monday still
need a real signed-in page each (§8).

### 13.10 Tests

Added in Phase 7: the reachability, quit and bounds tests (#96); rail navigation and IPC-sender
tests (#97); crash recovery, hidden-window unread and broadcast-storm tests (#98, #100); link
routing, mailto, pop-out, notification history and maximise tests; and unit tests for every new
pure rule. Each new E2E test was run against its bug put back.

Still open: axe checks on the renderer surfaces; the Settings window under Playwright; an opt-in
catalog test that follows redirects (would have caught Notion and `cloud.microsoft`, needs network).
One unit test failed once and never again in a dozen runs; which one was not captured.

### 13.11 Housekeeping

`spikes/google-login/sessions` is ~808 MB of **real cookie jars** (gitignored, but live
credentials on disk); `out-check/` and the stale August DMGs in `dist/` can go.

