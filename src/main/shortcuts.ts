import type { Input, WebContents } from 'electron';
import type { Command } from '../shared/types';

/**
 * Accelerators via `before-input-event` on each web contents, deliberately not `globalShortcut`:
 *
 *  - `before-input-event` fires in main *before* the page sees the key, so a web app can't swallow
 *    ⌘K. Slack and Notion both bind it themselves.
 *  - `globalShortcut` would steal keys system-wide even when Hangar isn't focused, which is
 *    hostile behaviour for a background app.
 */

/**
 * Returns whether the command was acted on. The caller only swallows the keystroke when it was —
 * Escape has to reach the page when the overlay is closed, or web apps can't dismiss their own
 * dialogs.
 */
export type CommandSink = (command: Command) => boolean;

export function translate(input: Input): Command | null {
  if (input.type !== 'keyDown') return null;

  // Escape is bound on *every* webContents, not just the overlay's. before-input-event only fires
  // for whichever contents holds focus, and the overlay doesn't reliably win focus from a service
  // view — so binding it only there left a blank overlay with no way out.
  if (input.key === 'Escape' && !input.meta && !input.control && !input.alt) {
    return { type: 'close-overlay' };
  }

  const mod = process.platform === 'darwin' ? input.meta : input.control;
  if (!mod) return null;

  const key = input.key.toLowerCase();

  if (input.alt) {
    if (key === 'arrowleft') return { type: 'cycle-pane', delta: -1 };
    if (key === 'arrowright') return { type: 'cycle-pane', delta: 1 };
    // ⌘⌥1..9 → workspace. Resolved to an id by the caller, which knows the workspace list.
    const n = Number(key);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      return { type: 'set-workspace', workspaceId: `#${n}` };
    }
    return null;
  }

  if (key === 'k') return { type: 'open-palette' };
  if (key === 'f') return { type: 'open-find' };
  if (key === 'p') return { type: 'print' };
  // '=' is the unshifted key on most layouts; '+' when shift is held.
  if (key === '=' || key === '+') return { type: 'zoom', direction: 'in' };
  if (key === '-') return { type: 'zoom', direction: 'out' };
  if (key === '0') return { type: 'zoom', direction: 'reset' };
  if (key === '\\') return { type: 'split' };
  if (key === '[') return { type: 'navigate', direction: 'back' };
  if (key === ']') return { type: 'navigate', direction: 'forward' };
  if (key === 'w') return { type: 'close-pane', paneId: '#focused' };

  // ⌘1..9 → nth service in the active workspace. Also resolved by the caller.
  const n = Number(key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) {
    return { type: 'focus-service', serviceId: `#${n}` };
  }

  return null;
}

/**
 * Idempotent by design. This used to be called from the focus path, which quietly added a second
 * listener to the same webContents on every focus — three focuses meant one ⌘\ split three times.
 * The WeakSet makes that class of bug impossible to reintroduce from any call site.
 */
const attached = new WeakSet<WebContents>();

export function attachShortcuts(wc: WebContents, sink: CommandSink): void {
  if (attached.has(wc)) return;
  attached.add(wc);

  wc.on('before-input-event', (event, input) => {
    const command = translate(input);
    if (!command) return;
    // Swallow only what we actually handled, so an unconsumed Escape still reaches the page.
    if (sink(command)) event.preventDefault();
  });
}
