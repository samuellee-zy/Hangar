import { dialog } from 'electron';

/**
 * Keeping a missing terminal from killing the app.
 *
 * The app logs unconditionally every 60 seconds (session persistence, and the cookie promotion
 * inside it). When the process is started from a terminal that later goes away — an editor's
 * integrated shell, a CI job, an agent harness, `npm run dev` in a window you close — stdout and
 * stderr are a pipe whose reader no longer exists, and the next write raises `EPIPE`. Without
 * something here, that arithmetic guarantees a crash within a minute of the reader disappearing.
 *
 * The write is the right place to stop it. Once output has nowhere to go there is nothing to be
 * gained by trying again, so the first broken write mutes the rest. That also covers Electron's own
 * internal logging, which resolves `console.error` from the global at call time — `webFrameMain.send`
 * reports a send to a disposed frame that way, and that is the exact write that took the app down.
 */

/**
 * `EPIPE` is the common case; the rest are the same condition caught at a different layer. A stream
 * torn down mid-write reports `ERR_STREAM_DESTROYED`, and a closed file descriptor `EBADF`.
 */
const BROKEN_PIPE = new Set([
  'EPIPE',
  'EIO',
  'EBADF',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);

export function isBrokenPipe(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && BROKEN_PIPE.has(code);
}

export interface WriteGuard {
  muted(): boolean;
  mute(): void;
}

export type Writer = Pick<Console, 'log' | 'warn' | 'error'>;

const METHODS = ['log', 'warn', 'error'] as const;

/**
 * Wraps a console so a broken pipe silences it instead of throwing.
 *
 * Anything that is *not* a broken pipe still throws. A console that swallowed every error would
 * hide real bugs in whatever was being logged, and this exists to remove one specific failure, not
 * to make logging unfailable.
 */
export function guardWrites(target: Writer): WriteGuard {
  let muted = false;

  for (const method of METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]): void => {
      if (muted) return;
      try {
        original(...args);
      } catch (error) {
        if (!isBrokenPipe(error)) throw error;
        muted = true;
      }
    };
  }

  return {
    muted: () => muted,
    mute: () => {
      muted = true;
    },
  };
}

let guard: WriteGuard | null = null;

/** Whether output has been given up on. Diagnostic — by definition it cannot be logged. */
export const outputMuted = (): boolean => guard?.muted() ?? false;

/**
 * Reproduces what Electron would have shown.
 *
 * Electron installs its own `uncaughtException` handler in `lib/browser/init.ts`, and the first
 * thing it does is `if (process.listenerCount('uncaughtException') > 1) return` — so registering
 * one here does not add to its behaviour, it replaces it. Anything this function does not display
 * is a crash that vanishes silently. The wording matches Electron's so the dialog is unchanged.
 *
 * Note it does not exit, also matching Electron ("Don't quit on fatal error").
 */
function reportFatal(error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const stack = err.stack ? err.stack : `${err.name}: ${err.message}`;
  dialog.showErrorBox(
    'A JavaScript error occurred in the main process',
    `Uncaught Exception:\n${stack}`
  );
}

/**
 * Call once, before anything that might log. Idempotent, because `activate` can rebuild most of the
 * app and a second wrap would nest the guards.
 */
export function installLogGuards(): void {
  if (guard) return;
  guard = guardWrites(console);

  // The synchronous throw `guardWrites` catches is only one of the two paths a failed write can
  // take. A pipe that breaks after the write is dispatched surfaces as an 'error' event instead,
  // and an unhandled one of those is fatal in its own right.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: unknown) => {
      if (!isBrokenPipe(error)) throw error;
      guard?.mute();
    });
  }

  process.on('uncaughtException', (error) => {
    if (isBrokenPipe(error)) {
      // Nothing reached the guard — a write we don't own. Same conclusion: stop trying.
      guard?.mute();
      return;
    }
    reportFatal(error);
  });

  // Node's default for an unhandled rejection is to raise it as an uncaught exception. Rethrowing
  // preserves that exactly, rather than quietly downgrading every unawaited promise to a log line.
  process.on('unhandledRejection', (reason) => {
    if (isBrokenPipe(reason)) return;
    throw reason;
  });
}
