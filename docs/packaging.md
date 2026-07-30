# Packaging

```bash
npm run dist
```

Builds `dist/Hangar-0.1.0-arm64.dmg` and `dist/Hangar-0.1.0.dmg` (Intel), unsigned. Roughly 116 MB
each — that's Chromium, and there's no way around it for an Electron app.

`npm run dist:signed` is the same thing without `--mac.identity=null`, for when a Developer ID
certificate is present in the keychain.

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

## What signing would unlock

Unsigned is fine for your own machine — Gatekeeper needs a right-click → Open the first time, and
after that it's a normal app. Three things stay broken until there's a Developer ID:

**Launch at login does not work.** macOS registers login items against a code signature; with
nothing to trust it refuses with "Operation not permitted", logged by Chromium's native layer so it
never throws. `applyLoginItem` now *reads the setting back* to find out whether it took, rather
than assuming — a toggle that quietly does nothing is worse than one that admits it can't. Settings
says so on the control.

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
