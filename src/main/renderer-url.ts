import path from 'node:path';
import type { WebContents } from 'electron';

// The rail and the overlay are two routes of the same React bundle, selected by hash.
// electron-vite sets ELECTRON_RENDERER_URL in dev; in production we load the built file.

/**
 * Renderer consoles are invisible from the terminal, so a React error in the rail or overlay just
 * looks like "the UI does nothing". Forwarding them to the main log makes those failures findable
 * without opening DevTools on a transparent, click-through view.
 */
export function forwardConsole(wc: WebContents, label: string): void {
  wc.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.log(`[${label}] ${event.level}: ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
}

export function loadRoute(wc: WebContents, route: 'rail' | 'overlay' | 'settings' | 'empty' | 'find'): void {
  forwardConsole(wc, route);
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void wc.loadURL(`${devUrl}#${route}`);
  } else {
    void wc.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: route });
  }
}
