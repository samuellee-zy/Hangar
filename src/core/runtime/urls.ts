/**
 * Which URLs may leave the app, and which count as the app's own.
 *
 * Pure, because both are security decisions and a rule you can only exercise with a live window is a
 * rule nobody checks. Main supplies the facts (the dev server URL, the built renderer's path); this
 * decides.
 */

/**
 * Schemes a page may hand to the operating system.
 *
 * Everything leaving the allowlist goes to `shell.openExternal`, which opens *whatever handles the
 * scheme* — and macOS registers a handler for far more than the browser. `file:` launches apps and
 * opens documents, `x-apple.systempreferences:` opens panes of System Settings, `smb:` and `afp:`
 * mount network shares, and any page in any service could reach them with a link or a popup.
 *
 * So an allowlist, like permissions: the web, mail and phone links, and the desktop apps a web
 * service legitimately hands off to — joining a Zoom or Teams call from a calendar invite is the
 * case this exists for. A scheme not named here is refused and logged; adding one is a deliberate
 * edit, not something a page can arrange.
 */
const EXTERNAL_SCHEMES = new Set([
  'http:',
  'https:',
  'mailto:',
  'tel:',
  'sms:',
  'facetime:',
  'facetime-audio:',
  // Calls and meetings: the invite link in Calendar, Gmail or Slack is one of these.
  'zoommtg:',
  'zoomus:',
  'msteams:',
  'webex:',
  'wbx:',
  // Desktop apps of services in the catalog, which their web apps offer to open.
  'slack:',
  'discord:',
  'figma:',
  'linear:',
  'notion:',
  'spotify:',
  'tg:',
  'whatsapp:',
  'obsidian:',
  'vscode:',
]);

export type ExternalDecision = { open: true } | { open: false; reason: string };

export function externalOpenDecision(raw: string): ExternalDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { open: false, reason: 'not a URL' };
  }
  if (!EXTERNAL_SCHEMES.has(url.protocol)) {
    return { open: false, reason: `scheme ${url.protocol} is not one Hangar hands to the system` };
  }
  // `http://` with no host is `new URL`'s parse of nonsense like `http:foo`, and there is nothing
  // for a browser to open.
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) {
    return { open: false, reason: 'no host' };
  }
  return { open: true };
}

/** http or https with a host: the only URLs a service may be, or navigate its own views to. */
export function isWebUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

export interface AppRenderer {
  /** `ELECTRON_RENDERER_URL` in development; unset in a build. */
  devUrl?: string;
  /** Absolute path of the built renderer's index.html. */
  indexFile: string;
}

/**
 * Whether a URL is one of the app's own screens — the rail, Settings, the overlays.
 *
 * Those views hold `window.hangar`, which can send any command: add a service, change the sync
 * repo, set a service's custom JavaScript. A drag-and-dropped link, a stray `target="_blank"` or a
 * redirect that took one of them anywhere else would hand that bridge to whatever page arrived. So
 * they may only ever show this renderer, and main only listens to IPC from frames showing it.
 *
 * A `file:` URL matches on the exact path, not on the scheme — dropping a file onto the rail is a
 * navigation to that file.
 */
export function isAppRendererUrl(raw: string, app: AppRenderer): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (app.devUrl) {
    try {
      return url.origin === new URL(app.devUrl).origin;
    } catch {
      return false;
    }
  }
  if (url.protocol !== 'file:') return false;
  const normalise = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalise(decodeURIComponent(url.pathname)) === normalise(app.indexFile);
}

/**
 * How many times a source may do something within a window, for things a page can trigger in a
 * loop — a script calling `window.open` on a timer would otherwise open a browser tab per tick.
 *
 * Per key, sliding window, clock injected for tests.
 */
export function createRateLimiter(opts: { max: number; windowMs: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((at) => t - at < opts.windowMs);
    if (recent.length >= opts.max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    return true;
  };
}

/**
 * Scheme, host and path only — for logs.
 *
 * Sign-in URLs carry `login_hint`, `state` and nonces in their query strings, and the log is a
 * plain file that ends up pasted into bug reports. The log already had a user's email address in it
 * this way, inside an MSAL `login_hint`.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const base = url.host ? `${url.protocol}//${url.host}${url.pathname}` : `${url.protocol}${url.pathname}`;
    return url.search || url.hash ? `${base}?…` : base;
  } catch {
    return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
  }
}

/** Every web URL inside a piece of text, redacted. For log lines we don't write ourselves. */
export function redactUrlsIn(text: string): string {
  return text.replace(/https?:\/\/[^\s'"<>]+/g, (url) => redactUrl(url));
}

/**
 * A new window with nothing loaded yet — `window.open()` with no URL, or `about:blank`. Web apps open
 * one and write into it themselves: Slack draws a huddle that way. It has no address of its own
 * and inherits the origin of the page that opened it.
 */
export function isBlankPage(url: string | undefined): boolean {
  if (url === undefined) return false;
  const trimmed = url.trim();
  return trimmed === '' || /^about:blank([?#].*)?$/i.test(trimmed);
}

