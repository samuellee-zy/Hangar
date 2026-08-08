import type { WebContents } from 'electron';
import { translate, type KeyContext } from '@core/keyboard/keymap';
import type { Command } from '@shared/types';

/**
 * Accelerators via `before-input-event` on each web contents, deliberately not `globalShortcut`:
 *
 *  - `before-input-event` fires in main *before* the page sees the key, so a web app can't swallow
 *    ⌘K. Slack and Notion both bind it themselves.
 *  - `globalShortcut` would steal keys system-wide even when Hangar isn't focused, which is
 *    hostile behaviour for a background app.
 *
 * Since rebinding landed this is also the *only* thing that dispatches a shortcut: the menu
 * declares its accelerators with `registerAccelerator: false`, so they are shown and not
 * registered. An accelerator registered by the menu fires at the application level and would
 * outrank anything decided here, which is what made a rebound ⌘K impossible.
 *
 * Which keystroke means what is `core/keyboard/keymap.ts`. This file is the wiring.
 */

/**
 * Returns whether the command was acted on. The caller only swallows the keystroke when it was —
 * Escape has to reach the page when the overlay is closed, or web apps can't dismiss their own
 * dialogs.
 */
export type CommandSink = (command: Command) => boolean;

/**
 * The bindings and passthrough list in force for a surface, read fresh on every keystroke.
 *
 * A function rather than a value because both halves change under a live view: rebinding a chord
 * in Settings must take effect in a Slack tab that has been open for an hour, and a snapshot taken
 * at `attachShortcuts` time would keep the old map until that view was recreated.
 */
export type KeyContextSource = () => KeyContext;

/**
 * Idempotent by design. This used to be called from the focus path, which quietly added a second
 * listener to the same webContents on every focus — three focuses meant one ⌘\ split three times.
 * The WeakSet makes that class of bug impossible to reintroduce from any call site.
 */
const attached = new WeakSet<WebContents>();

export function attachShortcuts(
  wc: WebContents,
  sink: CommandSink,
  context: KeyContextSource
): void {
  if (attached.has(wc)) return;
  attached.add(wc);

  wc.on('before-input-event', (event, input) => {
    const command = translate(input, context());
    if (!command) return;
    // Swallow only what we actually handled, so an unconsumed Escape still reaches the page.
    if (sink(command)) event.preventDefault();
  });
}
