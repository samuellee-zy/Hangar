/**
 * Whether the app is genuinely on its way out.
 *
 * "Close to tray" intercepts the window's close event and hides instead — but that must not happen
 * when the *app* is quitting, or ⌘Q would silently do nothing. This flag is the difference, and it
 * lives in its own module so `window.ts` doesn't have to import `index.ts` and create a cycle.
 */

let quitting = false;

export const isQuitting = () => quitting;
export const beginQuit = () => (quitting = true);
