/**
 * Which permissions a service may have. Pure, so the policy is testable and reviewable in one place.
 *
 * Before this, every service got an identical grant — `notifications`, `media`, `clipboard-read`,
 * `clipboard-sanitized-write` and `fullscreen` — which meant a **custom connection to an arbitrary
 * URL could take the microphone and camera on request, with no prompt.** That's a real hole: the
 * catalog is curated, but "add any website by URL" is not.
 *
 * Two principles:
 *
 *   1. **Deny by default.** Anything not named here is refused. Electron keeps adding permission
 *      types (HID, serial, USB, idle detection); an allowlist means a new one arrives denied rather
 *      than silently granted.
 *   2. **Trust follows provenance.** A catalog entry was reviewed when it was added. A URL the user
 *      typed was not, so it starts with less.
 */

/** Granted to any service. None of these can reach hardware or read the clipboard silently. */
const BASELINE = new Set([
  'notifications',
  'fullscreen',
  'clipboard-sanitized-write', // write-only, and sanitised
  'pointerLock',
]);

/** Additionally granted to curated catalog services. */
const CURATED = new Set([
  'media', // microphone and camera — Meet, Teams and Slack calls need it
  'clipboard-read',
  'display-capture', // screen share
]);

export interface PermissionContext {
  permission: string;
  /** False for custom connections — a URL the user typed, not a reviewed catalog entry. */
  isCatalogService: boolean;
  /** Per-service opt-in, letting a custom connection have camera and mic if the user says so. */
  allowMedia: boolean;
}

export function decidePermission(ctx: PermissionContext): boolean {
  if (BASELINE.has(ctx.permission)) return true;

  if (CURATED.has(ctx.permission)) {
    // A custom connection gets these only when explicitly enabled for that service.
    return ctx.isCatalogService || ctx.allowMedia;
  }

  // geolocation, hid, serial, usb, midi, idle-detection, bluetooth, and anything Electron adds
  // later. If one of these turns out to be needed, add it deliberately.
  return false;
}

/**
 * Partition directories with no account pointing at them.
 *
 * Deliberately *reported*, not deleted automatically. These are cookie jars — a bug in the
 * reachability calculation would silently sign the user out of everything, and doing that at boot
 * with no confirmation is exactly the class of mistake this codebase has already made once with
 * config. The user triggers the cleanup.
 */
export function findOrphanPartitions(inUse: string[], onDisk: string[]): string[] {
  // Account partitions are stored with the `persist:` prefix; directories are not.
  const live = new Set(inUse.map((p) => p.replace(/^persist:/, '')));
  return onDisk.filter((dir) => !live.has(dir)).sort();
}
