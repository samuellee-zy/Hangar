# Backlog — what isn't done

Everything Hangar doesn't do yet, why, and what it would take. Categorised by **the kind of
blocker**, not by feature area, because that's what determines whether something is a decision, a
purchase, or an afternoon.

Last updated after Phase 3.7 (packaging). The app is feature-complete for daily use: 162 automated
checks, a packaged DMG, and every shipped control does something.

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
| **Web Push delivery** | Registration and interception are confirmed live in the page's world; an actual push arriving is not. | Configure Firebase, hibernate Slack, DM yourself. |
| **Find in page** | Documented and wired, no runtime probe. The overlay-vs-own-view reasoning is sound but untested against a real page. | ⌘F in Gmail, check the match count and ↑/↓. |
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

162 checks, all over **pure modules**. That was a deliberate architecture — policy extracted from
Electron so it's testable under plain node — and it's why there are 162 rather than none.

What it doesn't cover:

- **`window.ts` (~1,200 lines) and `service-manager.ts`** have no automated tests. They're the
  Electron-coupled orchestration layer. Every bug found by the runtime probe lived here.
- **No integration or E2E tests.** The `HANGAR_PROBE=1` harness is manual and its assertions are
  `console.log` lines a human reads.
- **No renderer tests.** No React component is tested.
- **The probe's timing is racy** — icon counts read 0, 4 and 9 across three runs at the same 3-second
  mark, because icons load asynchronously. Fine for a diagnostic, wrong for a test.

**Highest value next:** promote the probe to a real harness with assertions and a non-zero exit
code, so "the UI does nothing" gets caught by CI rather than by noticing.

---

## 6. Known behaviours worth writing down

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

## 7. Suggested order

If picking this up fresh:

1. **Accessibility roles** (§4.3) — cheapest real quality win, and currently the weakest area.
2. **Reset to defaults** (§4.2) — small, and removes the only "edit the JSON" recovery path.
3. **Promote the probe to a real test harness** (§5) — everything after this gets safer.
4. **Verify the unverified** (§2) — an afternoon with a checklist, no new code.
5. **Code signing** (§1.1) — a purchase decision; unblocks three things at once.
6. **Drag onto a pane / into a folder** (§4.1) — the two gestures people will try and find missing.
