# Packaging

For your own Mac, one command:

```bash
npm run install:local
```

It builds this Mac's architecture only, signs it, quits the running copy, swaps
`/Applications/Hangar.app` in place and starts it again — under launchd, if launch at login is on.
Run it again after every change; that is the whole update story for a local build.

`npm run dist` still builds the two DMGs (`dist/Hangar-0.1.0-arm64.dmg` and the Intel one, roughly
116 MB each — that's Chromium) for handing to someone else, **unsigned**: `-c.mac.identity=null`
makes electron-builder skip signing altogether. `npm run dist:signed` is the same without that flag,
for when a Developer ID certificate is in the keychain.

## Installing it, and getting off the terminal

Running the app through `npm run dev` makes it a child of whatever shell started it, which is how a
closed terminal came to take the app down overnight — see [decision #92](decisions.md). A
Finder-launched `.app` has no such parent, and its stdout is not a pipe whose reader can disappear.

`install:local` does, in order:

1. `npm run build` and `npm run icon`.
2. `electron-builder --mac dir --<this arch>`, signed (next section), with hardened runtime and
   timestamping off — both exist for notarisation, and hardened runtime with anything but a
   Developer ID can stop the app launching.
3. `codesign --verify --deep --strict`, and stops if that fails.
4. Quits the running copy **gracefully**. It is usually the launchd job, and killing it is an
   unsuccessful exit that launchd answers by starting it again — possibly mid-copy. So it asks:
   `Hangar --quit` first (no dialog, cookies promoted, exit 0), then AppleScript's quit for builds
   older than that flag (which does show "Quit Hangar?" if you have confirm-before-quitting on), and
   only then `launchctl bootout` and a signal.
5. Copies to `Hangar.app.new` with `ditto` and renames it into place, so there is never a
   half-copied app at the real path.
6. Starts it: `launchctl bootstrap`/`kickstart` when there is a login item for this copy, `open`
   otherwise.

No Gatekeeper step: a bundle you built yourself is never quarantined. (For a DMG from somewhere
else, the old right-click → **Open** bypass is gone from macOS 15 on; it is System Settings →
Privacy & Security → **Open Anyway** now.)

Close to tray is worth turning on, so ⌘W leaves it running in the menu bar rather than quitting it.
There is no longer a "start hidden" — see [decision #96](decisions.md): it hid every start of the
installed app, and with the Dock icon unable to show a hidden window, left it running and
unreachable. The Dock icon, Window → Show Hangar, the Dock menu and the tray all bring the window
back now.

### Signing — why a local build is signed at all

macOS **does not deliver notifications to an unsigned app**, and says nothing when it drops them.
That alone rules out `identity=null` for a copy you use. There are two ways to sign without a
Developer ID, and `install:local` picks for you:

| Identity | How | Notifications | Camera / microphone grants |
| --- | --- | --- | --- |
| Self-signed "Hangar Local" | `npm run cert:local`, once | Delivered | **Survive rebuilds** — same identity every build |
| Ad-hoc (`-`) | The default when there is no certificate | Delivered | Asked again after every install — the signature is a hash of the bundle |

`cert:local` creates a certificate in your login keychain, usable for code signing only, and trusts
it for that (macOS asks for your password). The first build afterwards may ask whether `codesign`
may use the key; choose **Always Allow**. It is removable in Keychain Access under My Certificates.
It is not a Developer ID: another Mac still won't open the app.

If you switch from ad-hoc to the certificate, macOS may keep an old camera or microphone decision
against the previous identity. `tccutil reset Camera com.hangar.desktop` (and `Microphone`) clears it.

`Notification` failures are logged now (`[notification] … not delivered`), so if banners stop, the
log says why.

### Launch at login works unsigned, via a LaunchAgent

The in-app toggle works. It does not use `app.setLoginItemSettings` — macOS refuses that without a
Developer ID (below) — but writes a user LaunchAgent instead, which carries no such requirement:

```
~/Library/LaunchAgents/com.hangar.desktop.plist
```

**Both toggles take effect at the next login, not immediately** — unless you install with
`install:local`, which bootstraps the job for you. The app writes the plist and never runs
`launchctl`, because the effect that writes it also runs on every `activate`, and booting a job out
would terminate the very app doing it. See [decision #93](decisions.md).

Only a copy in an Applications folder writes it. Opening a build straight from `dist/` used to
repoint login at the build directory, which the next clean build then deleted.

**Relaunch if it stops unexpectedly** adds `KeepAlive: { SuccessfulExit: false }` to the same job.
Two things to know:

- It only supervises a Hangar that *launchd* started. One opened from Finder or `npm run dev` is not
  a launchd job, so killing that copy proves nothing — it will not come back, and that is correct.
  Verification has to cross a logout.
- It covers the process dying: native crashes, OOM kills, Force Quit. It does not cover a JavaScript
  exception, which shows a dialog and keeps running rather than exiting.

Force Quit becomes sticky once it is on, since that is exactly what it is for. To stop a job for the
rest of the session without logging out:

```bash
launchctl bootout gui/$(id -u)/com.hangar.desktop
```

The manual route still works as a fallback, and is unaffected by any of this: **System Settings →
General → Login Items → Open at Login → +**. Don't use both — that is two registrations and two
launches, the second discarded by the single-instance lock.

### A dev instance and the installed app share a profile

`userData` holds the config *and* every session partition, and both launches resolve the same one.
Electron's single-instance lock is keyed on that directory, so this is safe by default — **verified,
not assumed**: two independently launched instances pointed at one profile log

```
[boot] single-instance lock: acquired
[boot] single-instance lock: denied — handing off and quitting
```

and the second exits before it can touch a cookie jar. `LSMultipleInstancesProhibited` is a separate
mechanism covering duplicate launches of the same bundle; the lock is what spans *different* ones.

The consequence is that with the packaged app running, `npm run dev` won't start — it hands off and
quits. Use `npm run dev:isolated`, which points `HANGAR_USER_DATA` at
`~/Library/Application Support/Hangar (dev)`: a separate profile, a separate lock, both running at
once. Plain `npm run dev` deliberately keeps the real profile, because testing unread detection
needs real logins and a fresh profile has none.

## The app icon is generated, not committed

`npm run icon` renders `build/icon.icns` from an SVG written inline in
[`scripts/make-icon.mjs`](../scripts/make-icon.mjs). It's part of `npm run dist`, so it stays in
step automatically.

**Electron is the rasterizer.** A stock Mac has no `rsvg-convert`, ImageMagick or Inkscape, and
adding one as a build dependency to draw a single icon isn't worth it — Chromium is already here,
and renders it with the same engine that draws the app.

Two things learned doing it:

- A `data:` URL doesn't work. Chromium refuses them past a length limit and this SVG is comfortably
  over, failing as a bare `ERR_FAILED (-2)` with nothing else to go on. It renders from a temp file.
- Rendering each size in its own offscreen window fails on the *second* window, same opaque error.
  So it renders once at 1024 and downscales with `quality: 'best'`, which is what icon tooling
  generally does anyway — and guarantees all ten sizes are the same artwork.

The icon is a rail with service dots beside two panes, the left one focused. The rail is
deliberately narrower and a different fill from the panes: at equal widths the three read as
generic columns, and the shape stops saying anything about what the app is. At 32px the coloured
dots are what remain legible.

## Icons live outside the asar

`app.getAppPath()` points *inside* the archive once packaged, and Chromium can't read an SVG from a
path that doesn't exist on disk. So brand icons ship as `extraResources` and
[`icons.ts`](../src/main/features/icons.ts) resolves `process.resourcesPath` when packaged.

These two halves have to stay in step — if the `extraResources` block moves, that lookup moves with
it. Getting it wrong means every service tile falls back to initials, and only in the packaged
build, which is the worst place to find out.

Verified live: the packaged app reports 9 brand icons rendered in the rail.

## Info.plist usage strings are load-bearing

macOS **kills the app outright, with no dialog**, if a permission is requested without a usage
string in Info.plist. Catalog services can be granted microphone and camera (see
[`permissions.ts`](../src/core/runtime/permissions.ts)), so `NSMicrophoneUsageDescription` and
`NSCameraUsageDescription` aren't boilerplate — without them, the first Slack huddle terminates
Hangar.

`LSMultipleInstancesProhibited` is also set. Without it, launching a second copy silently does
nothing instead of focusing the running one.

## What a Developer ID would unlock

A local signature — self-signed or ad-hoc — is fine for your own machine. Two things stay broken
until there's a Developer ID:

**Distribution to anyone else.** An unsigned, un-notarised DMG shows the "damaged and can't be
opened" dialog on another Mac. That message is a lie — it means unsigned — but there's no way to
tell a recipient otherwise.

**Auto-update.** Deliberately not configured (`publish: null`). An updater on an unsigned build is
a mechanism for handing someone else's binary to your users; it needs signing and notarisation
first, not as a follow-up.

A Developer ID costs $99/year through the Apple Developer Program. `dist:signed` is ready for it;
notarisation would need `notarize` in the config plus an app-specific password.

## Build contents

| Included | Why |
| --- | --- |
| `out/**` | The built main, preload and renderer bundles |
| `package.json` | Electron reads `main` from it at runtime |
| `node_modules` (production only) | electron-builder prunes dev dependencies itself |
| `assets/icons/*.svg` + `NOTICE` | As `extraResources`, outside the asar |

Source, `scripts/`, `docs/` and the check harness are excluded. electron-builder's default is to
include everything not explicitly listed, so the `files` block is an allowlist rather than a
convenience.
