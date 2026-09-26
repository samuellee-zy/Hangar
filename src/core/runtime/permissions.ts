/**
 * Which permissions a service may have. Pure, so the policy is testable and reviewable in one place.
 *
 * Before this, every service got an identical grant — `notifications`, `media`, `clipboard-read`,
 * `clipboard-sanitized-write` and `fullscreen` — which meant a **custom connection to an arbitrary
 * URL could take the microphone and camera on request, with no prompt.** That's a real hole: the
 * catalog is curated, but "add any website by URL" is not.
 *
 * Three principles:
 *
 *   1. **Deny by default.** Anything not named here is refused. Electron keeps adding permission
 *      types (HID, serial, USB, idle detection); an allowlist means a new one arrives denied rather
 *      than silently granted.
 *   2. **Trust follows provenance.** A catalog entry was reviewed when it was added. A URL the user
 *      typed was not, so it starts with less.
 *   3. **Trust belongs to the service, not to whatever it embeds.** A request from an iframe on
 *      some other origin — an ad, an embed, a tracker inside Slack — is not Slack asking, and gets
 *      only what cannot reach hardware, the clipboard or the user's attention.
 */

/** Granted to any frame at all, the service's own or an embed. Harmless whoever asks. */
const ANY_FRAME = new Set([
  'fullscreen', // a video embed going fullscreen
  'clipboard-sanitized-write', // write-only, and sanitised — an embed's "copy" button
  'pointerLock',
]);

/** Granted to any service's own frames. Nothing here can reach hardware or read the clipboard. */
const BASELINE = new Set(['notifications']);

/** Additionally granted to curated catalog services. */
const CURATED = new Set([
  'media', // microphone and camera — Meet, Teams and Slack calls need it
  'clipboard-read',
  'display-capture', // screen share
]);

export interface PermissionContext {
  permission: string;
  /**
   * The requesting frame's URL is on the service's own allowlist. False for a third-party iframe,
   * and for a request that cannot be attributed to a service at all.
   */
  fromService: boolean;
  /** False for custom connections — a URL the user typed, not a reviewed catalog entry. */
  isCatalogService: boolean;
  /** Per-service opt-in, letting a custom connection have camera and mic if the user says so. */
  allowMedia: boolean;
}

export function decidePermission(ctx: PermissionContext): boolean {
  if (ANY_FRAME.has(ctx.permission)) return true;
  if (!ctx.fromService) return false;

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
