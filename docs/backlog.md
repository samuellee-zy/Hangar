# Backlog — what isn't done

Everything Hangar doesn't do yet, why, and what it would take. Categorised by **the kind of
blocker**, not by feature area, because that's what determines whether something is a decision, a
purchase, or an afternoon.

Last updated after **Phase 5** (renderer audit, accessibility, E2E, catalog, sync). 327 unit tests plus 8 Playwright end-to-end tests, enforced module
boundaries, a packaged DMG verified end to end, and every shipped control does something.

Phase 4 closed everything in the old §1.4 and most of §2 — including a P0 that destroyed the config
when you removed your last service, and the discovery that **Web Push had never worked for the case
it was built for**. See [decisions.md](decisions.md) #47–63 for the findings.

---

## 1. Blocked on something outside the code

Can't be finished by writing more of it. Each needs a purchase, an account, or an upstream change.

### 1.1 Code signing — $99/year Apple Developer Program

The single highest-leverage unblock here. Three things depend on it:

| Blocked | Detail |
| --- | --- |
| **Launch at login** | macOS registers login items against a code signature. Unsigned it refuses with "Operation not permitted" — logged by Chromium's native layer, so it never throws. `applyLoginItem` reads the setting back to detect this, and Settings says so on the control. |
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

---

## 4. Features not yet built

Wanted, unblocked, just not done. Roughly in value order.

### 4.1 Interaction

- **Drag a tile onto a pane** — currently a tile always opens in the focused pane or a new one.
  Dropping directly onto a specific pane is the obvious gesture and isn't wired ([decisions #10](decisions.md)).
- **Drag a service into a folder** — menu-only today (`Move to folder ▸`). Dragging works for
  reordering but not for nesting.
- **Compact rail hover-expand** — `compactRail` currently just narrows the rail to 48px. The
  intended behaviour is a sliver that expands on hover.
- **Wake-on-click affordance for sleeping tiles** — a sleeping tile is 50% opacity and a tooltip.
  Nothing says "click to wake", so it reads as broken rather than asleep.

### 4.2 Settings

- **Reset to defaults** — per section and globally. Not built at all. Notable because a bad rail
  position or zoom is currently only recoverable by editing `config.json`.
- **Keyboard rebinding** — the shortcut map is shown read-only. Needs rebinding, conflict
  detection, and a **per-service passthrough list** so a service can keep a chord for itself. ⌘K in
  Slack is the motivating case: Hangar swallows it for the palette.
- **Notification level per service in the UI** — `notificationLevel` is honoured everywhere but
  only reachable by editing config.

### 4.3 Accessibility

The weakest area in the app, and the one with no tests.

- The folder tree isn't announced as a tree — no `role="tree"` / `treeitem`, no expanded state.
- Panes have no landmark roles, so there's no way to navigate between them with a screen reader.
- Buttons have `aria-label`s; that's the extent of it.
- Focus management on overlay open/close is unverified.

**To do it:** roles and states first, then an actual VoiceOver pass. Fixing this properly is
probably a day, and it's the thing most likely to be embarrassing if anyone else uses this.

---

## 5. Testing gaps

262 tests under Vitest, plus `dependency-cruiser` on every run. The pure-module architecture is
what makes that possible, and `shell-state.ts` and `migrate.ts` were extracted from `app-window.ts`
and `config.ts` specifically so their logic could be reached.

What it still doesn't cover:

- **No integration or E2E tests.** `HANGAR_PROBE=1` now exercises the real paths — hibernated push
  delivery, window teardown and rebuild, the preload's main-world patches — but its assertions are
  `console.log` lines a human reads, not a failing exit code. **Promoting it to Playwright is the
  highest-value remaining test work**; the eight target cases are listed in the Phase 4 plan.
- **No renderer tests** beyond `accent.ts`. No React component is tested; `@testing-library/react`
  is the intended tool.
- **`app-window.ts` is still ~1,300 lines** and its Electron-coupled half — `relayout`,
  `openService`, `dispatch`'s side effects — remains untestable without a real window.
- **`tests/` is not typechecked.** Including it surfaces ~86 errors that are one real finding:
  fixtures for older config versions are honest about missing fields that the types declare
  required. Now that `migrateConfig` accepts partials this is mostly resolvable.
- **The probe's timing is racy** — icon counts read 0, 4 and 9 across runs at the same 3-second
  mark, because icons load asynchronously. Fine for a diagnostic, wrong for a test.

**Highest value next:** promote the probe to a real harness with assertions and a non-zero exit
code, so "the UI does nothing" gets caught by CI rather than by noticing.

---

## 6. Enhancements not yet built

**Catalog expansion.** 9 entries against Rambox's ~700 and Shift's ~1,500. Each is ~8 lines plus a
vendored icon; the real cost is curating `allowedHosts`, and getting one wrong sends the service's
own URL to the system browser. `catalog.test.ts` now asserts every entry allows its own URL, so the
expansion has a safety net. Target ~60.

**Ad and tracker blocking.** `@ghostery/adblocker-electron` — uBlock Origin/EasyList compatible,
serialises its engine to disk, applies per-session, which matches the existing architecture. A
Rambox Pro feature, and it measurably cuts memory across many loaded services.

**Config sync across machines.** Export already exists; this is a sync target plus conflict
handling. **Must exclude** `pushRegistrations` and anything partition-scoped — syncing those breaks
both machines.

**Per-service injected JS for unread.** Title patterns now cover Gmail, Slack, Teams and Linear
([decisions #64](decisions.md)). Rambox's primary mechanism is injected per-service JavaScript
querying known DOM nodes, which reaches services that don't put a count in the title at all. The
`customJs` seam already exists to hang it on.

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
- **`hibernateAfterMinutes` defaults to 0 (never).** Hibernation is opt-in; the memory saving is
  real but so is the cost of a cold load.
- **The tray shows a count as text, not a badge.** macOS trays have no badge API.
- **Icons load asynchronously** and take a second or two to populate on a cold start. Tiles show
  initials until then.

---

## 8. Suggested order

If picking this up fresh:

1. **Promote the probe to Playwright** (§5) — everything after it gets safer, and the probe already
   knows what to assert; it just can't fail a build.
2. **Per-service unread detection** (§6, D1) — the largest remaining correctness gap: unread is
   still a tally of `Notification` calls, so it only ever rises and reads zero for a service whose
   browser notifications are off.
3. **Accessibility roles** (§4.3) — cheapest real quality win, still the weakest area.
4. **Reset to defaults** (§4.2) — small, and removes the only "edit the JSON" recovery path.
5. **Verify the unverified** (§2) — an afternoon with a checklist, no new code.
6. **Code signing** (§1.1) — a purchase decision; unblocks three things at once.

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

## 10. Typechecking the tests — partially done

`npm run typecheck:tests` runs `tsconfig.test.json`, which extends the root config but relaxes
`noUncheckedIndexedAccess` and `noImplicitAny`. Both are right for `src/` and pure friction in
tests: `panes[0]!.id` on an empty array should fail as a *test*, not as a compile error, and
threading assertions through every fixture obscures what each case asserts.

**Not yet wired into `npm run check`: 54 errors remain** (down from 193). All are inline object
literals standing in for a full `Config` or a `WebContents` — deliberately partial fixtures, where
spelling out every field would bury what each case is about.

They need a typed fixture helper per file, written by hand. Two attempts to do it with a regex
produced unbalanced parens that broke a working suite, which is its own small lesson: a codemod is
right for a uniform transformation and wrong for one that needs to understand nesting.

What this exercise was actually worth: it found that `migrateV1`'s signature was **a lie**. It
declared its input as full `ServiceInstance`s, but v1 data has no `accountId` — creating it is the
function's entire job — and pre-2.0 data has no `zoom`, `hibernate` or `notifications` either. The
type asserted they were present, so nothing forced a caller to supply them and nothing filled them
in. That's the root of A11, and it's now `StoredService`, which says what's actually true.

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

### Still open

- **54 test-fixture type errors** (§10) — needs a hand-written fixture helper per file.
- **`app-window.ts` is ~1,450 lines.** Its pure logic is extracted and tested; the Electron-coupled
  half still needs a real window, which is what the E2E suite now covers.
- **Per-service injected JS for unread** — title patterns cover the services that show a count in
  the title; injected DOM queries would reach the ones that don't.
- **V8 snapshots** — measure first; startup may already be fine.
- **Signing** — ruled out. Note that Homebrew ends support for casks failing Gatekeeper on
  **1 Sept 2026**, so a cask is no longer a signing-free distribution route.
