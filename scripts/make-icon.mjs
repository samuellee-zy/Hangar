// Generates build/icon.icns from an SVG drawn here in code.
//
// Electron is the rasterizer. That isn't a workaround — it removes a build dependency (there's no
// rsvg/ImageMagick on a stock Mac) and it renders with the same engine that draws the app, so what
// you see in the icon is what Chromium would draw.
//
// The icon is generated rather than committed as a binary so it stays diffable and editable. Change
// the SVG below, re-run, done.
//
// Run: npm run icon

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { app, BrowserWindow } from 'electron';

const OUT = path.resolve('build');
const ICONSET = path.join(OUT, 'icon.iconset');

/**
 * The app is a rail plus panes, so that's what the icon is. It reads as a distinct silhouette at
 * 32px — where most icons turn to mush — because the rail is a solid block against two lighter
 * rectangles rather than fine detail.
 *
 * Drawn on a 1024 grid with macOS's own proportions: content inset to ~824px inside the canvas,
 * corner radius ~185, which is what Big Sur onwards uses for a squircle.
 */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#33333d"/>
      <stop offset="1" stop-color="#17171b"/>
    </linearGradient>
    <linearGradient id="paneActive" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.16"/>
    </linearGradient>
    <linearGradient id="pane" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.15"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.07"/>
    </linearGradient>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>

  <!-- Squircle. macOS does NOT mask this for you outside the App Store, so the shape is ours. -->
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
  <!-- A hairline top highlight is what stops a flat dark icon looking like a hole in the dock. -->
  <rect x="100" y="100" width="824" height="824" rx="185" fill="none"
        stroke="#ffffff" stroke-opacity="0.10" stroke-width="3"/>

  <g filter="url(#lift)">
    <!-- The rail. Narrower than a pane and a different fill, or the three read as equal columns
         and the icon says nothing about what the app is. -->
    <rect x="188" y="220" width="132" height="584" rx="46" fill="#ffffff" fill-opacity="0.07"/>
    <circle cx="254" cy="316" r="34" fill="#4c8dff"/>
    <circle cx="254" cy="428" r="34" fill="#3ecf8e"/>
    <circle cx="254" cy="540" r="34" fill="#f2b53d"/>
    <circle cx="254" cy="652" r="34" fill="#ffffff" fill-opacity="0.22"/>

    <!-- Two panes. The first is the focused one — brighter, with a title bar — so the icon shows a
         split view rather than two empty slabs. -->
    <rect x="368" y="220" width="238" height="584" rx="48" fill="url(#paneActive)"/>
    <rect x="404" y="272" width="120" height="26" rx="13" fill="#ffffff" fill-opacity="0.30"/>
    <rect x="404" y="330" width="166" height="18" rx="9" fill="#ffffff" fill-opacity="0.15"/>
    <rect x="404" y="376" width="140" height="18" rx="9" fill="#ffffff" fill-opacity="0.15"/>

    <rect x="646" y="220" width="190" height="584" rx="48" fill="url(#pane)"/>
    <rect x="682" y="272" width="96" height="26" rx="13" fill="#ffffff" fill-opacity="0.18"/>
  </g>
</svg>`;

async function main() {
  await app.whenReady();
  fs.rmSync(ICONSET, { recursive: true, force: true });
  fs.mkdirSync(ICONSET, { recursive: true });

  // ONE window, rendered once at full size, then downscaled.
  //
  // Rendering each size in its own offscreen window fails: the second `loadFile` returns a bare
  // ERR_FAILED (-2) with no further detail. Not worth chasing, because a single 1024 render
  // downscaled with `quality: 'best'` is what most icon tooling does anyway — and it guarantees
  // every size is the same artwork rather than seven independent renders that might disagree.
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
  });

  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  const page = path.join(OUT, '.icon.html');
  fs.writeFileSync(page, html);
  await win.loadFile(page);
  // A frame has to actually paint before capturePage returns pixels rather than transparency.
  await new Promise((r) => setTimeout(r, 600));

  const full = await win.webContents.capturePage();
  win.destroy();
  fs.rmSync(page, { force: true });
  if (full.isEmpty()) throw new Error('capturePage returned nothing — the page never painted');
  console.log(`  rendered ${full.getSize().width}x${full.getSize().height}`);

  // iconutil's naming scheme: 32x32 and 16x16@2x are the same pixels under two names, and both
  // must be present or macOS falls back to a blurry scale at whichever size it wanted.
  const outputs = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of outputs) {
    const resized = full.resize({ width: size, height: size, quality: 'best' });
    fs.writeFileSync(path.join(ICONSET, name), resized.toPNG());
  }
  console.log(`  wrote ${outputs.length} sizes`);

  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', path.join(OUT, 'icon.icns')]);
  // electron-builder wants a PNG alongside for Linux builds.
  fs.copyFileSync(path.join(ICONSET, 'icon_512x512.png'), path.join(OUT, 'icon.png'));
  console.log(`\nWrote ${path.join(OUT, 'icon.icns')}`);
  app.exit(0);
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
