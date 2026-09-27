import { shell } from 'electron';
import { createRateLimiter, externalOpenDecision, redactUrl as redact } from '@core/runtime/urls';

/**
 * The only way anything in Hangar hands a URL to the operating system.
 *
 * Four call sites used to call `shell.openExternal` directly, under `void`, so two things went
 * wrong at each: any scheme at all reached the OS (see `externalOpenDecision`), and a scheme with no
 * handler — a `zoommtg:` link on a Mac without Zoom — rejected with nothing to catch it, which the
 * unhandled-rejection guard turned into a modal error dialog.
 */

/**
 * Five opens per ten seconds per source. Generous for a person clicking links; a page opening
 * popups in a loop gets five browser tabs and a line in the log rather than hundreds.
 */
let allow = createRateLimiter({ max: 5, windowMs: 10_000 });

/** Forget every source's recent opens. For tests, which open far more than five in ten seconds. */
export function forgetExternalOpens(): void {
  allow = createRateLimiter({ max: 5, windowMs: 10_000 });
}

/** `source` is for the log and the rate limit: a service name, or where in the app it came from. */
export function openExternalSafely(url: string, source: string): void {
  const decision = externalOpenDecision(url);
  if (!decision.open) {
    console.warn(`[external] ${source}: refused ${redact(url)} — ${decision.reason}`);
    return;
  }
  if (!allow(source)) {
    console.warn(`[external] ${source}: refused ${redact(url)} — too many in a short time`);
    return;
  }
  shell.openExternal(url).catch((err: unknown) => {
    console.warn(`[external] ${source}: could not open ${redact(url)} — ${String(err)}`);
  });
}
