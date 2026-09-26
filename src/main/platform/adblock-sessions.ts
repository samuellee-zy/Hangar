/**
 * Turning one shared ad-blocking engine on and off in many sessions, which ghostery cannot do alone.
 *
 * ghostery's `BlockingContext.enable()` registers two global IPC handlers with `ipcMain.handle` —
 * on *every* session's enable — and `handle` throws for a channel that already has one. Worse, it
 * throws halfway: the session is already recorded as enabled and its preload registered, and its
 * network listeners are not yet installed. So with two accounts only the first was ever blocked,
 * the second was marked enabled and never retried, and the log said so on every boot:
 *
 *   [adblock] unavailable, continuing without it: Attempted to register a second handler for
 *   '@ghostery/adblocker/inject-cosmetic-filters'
 *
 * Disabling was the mirror image: `disable()` removes both handlers outright, taking cosmetic
 * filtering away from every other session too.
 *
 * Both handlers delegate to the engine, not to the session, so one registration serves every
 * session identically. That makes the fix simple: clear the channels before each enable, and put
 * them back after a disable while any session is still enabled.
 *
 * Dependencies are passed in rather than imported, so this runs under plain node against a fake
 * that fails the way ghostery does — the only way to test it, since the E2E suite runs with ad
 * blocking off (see e2e/harness.ts).
 */

export const COSMETIC_CHANNELS = [
  '@ghostery/adblocker/inject-cosmetic-filters',
  '@ghostery/adblocker/is-mutation-observer-enabled',
] as const;

/** The part of `ipcMain` this needs. */
export interface HandlerRegistry {
  handle(channel: string, listener: (event: never, ...args: never[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** The part of `ElectronBlocker` this needs. */
export interface SessionBlocker<S> {
  config: { loadCosmeticFilters: boolean };
  isBlockingEnabled(session: S): boolean;
  enableBlockingInSession(session: S): unknown;
  disableBlockingInSession(session: S): void;
  onInjectCosmeticFilters: (event: never, url: string, msg?: never) => unknown;
  onIsMutationObserverEnabled: (event: never) => unknown;
}

export function createSessionBlocking<S>(ipc: HandlerRegistry) {
  const enabled = new Set<S>();

  return {
    enable(blocker: SessionBlocker<S>, session: S): void {
      if (blocker.isBlockingEnabled(session)) return;
      for (const channel of COSMETIC_CHANNELS) ipc.removeHandler(channel);
      blocker.enableBlockingInSession(session);
      enabled.add(session);
    },

    disable(blocker: SessionBlocker<S>, session: S): void {
      if (!blocker.isBlockingEnabled(session)) return;
      blocker.disableBlockingInSession(session);
      enabled.delete(session);
      // `disable()` took the channels away from everyone; give them back if anyone is left.
      if (enabled.size > 0 && blocker.config.loadCosmeticFilters) {
        for (const channel of COSMETIC_CHANNELS) ipc.removeHandler(channel);
        ipc.handle(COSMETIC_CHANNELS[0], (event: never, url: never, msg: never) =>
          blocker.onInjectCosmeticFilters(event, url, msg),
        );
        ipc.handle(COSMETIC_CHANNELS[1], (event: never) => blocker.onIsMutationObserverEnabled(event));
      }
    },

    /** How many sessions are blocking right now. For the log, and for tests. */
    count: (): number => enabled.size,
  };
}
