import { app, protocol, net, type Session, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { catalogById } from '@shared/catalog';
import type { ServiceInstance } from '@shared/types';

/**
 * Icons reach the renderer over a `hangar-icon://<serviceId>` scheme rather than file:// paths,
 * which keeps the renderer's CSP tight and hides where the bytes actually come from.
 *
 * Two sources, in order:
 *   1. A vendored brand logo from assets/icons (catalog services) — offline, crisp, no network.
 *   2. A favicon captured from the page itself (custom connections).
 *
 * Deliberately NOT a third-party favicon service. Google's s2/favicons and DuckDuckGo's ip3 both
 * work fine and both would hand a remote server the list of apps you use — unacceptable for an app
 * whose whole pitch is that your service list stays on your machine.
 */

/** Per configured service, resolved to a vendored logo or a captured favicon. */
const SCHEME = 'hangar-icon';
/**
 * Per catalog *slug*. The Add Connection picker shows services that don't exist yet, so there's no
 * service id to key on — it needs the logo before anything is configured.
 */
const CATALOG_SCHEME = 'hangar-catalog';

/**
 * `app.getAppPath()` points inside the asar once packaged. Icons are declared as `extraResources`
 * in the build config, which unpacks them beside the app rather than into the archive — so the
 * packaged path is `process.resourcesPath`, not the app path. Getting this wrong means every icon
 * 404s in the shipped build and works perfectly in development.
 */
const vendoredDir = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'icons')
    : path.join(app.getAppPath(), 'assets', 'icons');
const cacheDir = () => path.join(app.getPath('userData'), 'icons');

/** Must run before app ready, or `protocol.handle` can't serve it to an <img>. */
export function registerIconScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: CATALOG_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function vendoredPath(svc: ServiceInstance): string | null {
  const slug = catalogById(svc.catalogId)?.icon;
  if (!slug) return null;
  const file = path.join(vendoredDir(), `${slug}.svg`);
  return fs.existsSync(file) ? file : null;
}

const FAVICON_EXTENSIONS = ['png', 'ico', 'svg', 'jpg', 'webp', 'gif'] as const;

/** Sniffs the real format. A .ico served as .png may simply not render. */
function extensionFor(buf: Buffer): (typeof FAVICON_EXTENSIONS)[number] {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01) return 'ico';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.subarray(0, 6).toString() === 'GIF89a' || buf.subarray(0, 6).toString() === 'GIF87a') return 'gif';
  if (buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  const head = buf.subarray(0, 300).toString('utf8').trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return 'png';
}

function cachedFaviconPath(serviceId: string): string | null {
  for (const ext of FAVICON_EXTENSIONS) {
    const file = path.join(cacheDir(), `${serviceId}.${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Resolution order puts the vendored logo first: a captured favicon is often a 16px bitmap, so
 * where we have a real vector mark it wins.
 */
export function installIconProtocol(services: () => ServiceInstance[]): void {
  protocol.handle(SCHEME, async (request) => {
    // `hangar-icon://<serviceId>` — the id lands in hostname, lowercased (uuids already are).
    const serviceId = new URL(request.url).hostname;
    const svc = services().find((s) => s.id === serviceId);
    if (!svc) return new Response('not found', { status: 404 });

    const file = vendoredPath(svc) ?? cachedFaviconPath(svc.id);
    if (!file) return new Response('no icon', { status: 404 });

    return net.fetch(`file://${file}`);
  });

  protocol.handle(CATALOG_SCHEME, async (request) => {
    const slug = new URL(request.url).hostname;
    // Slugs come from our own catalog, but this handler is reachable from renderer markup, so
    // reject anything that could climb out of assets/icons.
    if (!/^[a-z0-9-]+$/.test(slug)) return new Response('bad slug', { status: 400 });
    const file = path.join(vendoredDir(), `${slug}.svg`);
    if (!fs.existsSync(file)) return new Response('no icon', { status: 404 });
    return net.fetch(`file://${file}`);
  });
}

/**
 * How many times each service's favicon has been cached this run. Part of the icon's URL in the
 * renderer, so a newly written file is a new URL: without it a tile that had already 404'd showed
 * initials until the app restarted, because nothing told it an icon had arrived.
 */
const versions = new Map<string, number>();

export function iconVersions(): ReadonlyMap<string, number> {
  return versions;
}

/**
 * Cache the page's own favicon for services with no vendored logo. Fetched through the service's
 * session so authenticated favicons work, and so it goes out over the same proxy as everything else.
 * `onCached` runs after each write, so the window can tell its renderers.
 */
export function captureFavicon(
  wc: WebContents,
  svc: ServiceInstance,
  ses: Session,
  onCached: () => void,
): void {
  if (vendoredPath(svc)) return; // a real logo already beats anything the page can offer

  wc.on('page-favicon-updated', (_event, favicons) => {
    const url = favicons[0];
    if (!url) return;
    void (async () => {
      try {
        const res = await ses.fetch(url);
        if (!res.ok) return;
        const buf = Buffer.from(await res.arrayBuffer());
        // Guard against a service serving an HTML error page as its favicon.
        if (buf.length < 64) return;
        fs.mkdirSync(cacheDir(), { recursive: true });
        // Replace any earlier cache for this service so a format change can't leave two files.
        for (const ext of FAVICON_EXTENSIONS) {
          fs.rmSync(path.join(cacheDir(), `${svc.id}.${ext}`), { force: true });
        }
        fs.writeFileSync(path.join(cacheDir(), `${svc.id}.${extensionFor(buf)}`), buf);
        versions.set(svc.id, (versions.get(svc.id) ?? 0) + 1);
        onCached();
      } catch {
        // A missing favicon is cosmetic — the tile falls back to initials.
      }
    })();
  });
}

/**
 * Deletes a service's cached favicon. Called on removal.
 *
 * Small, but these accumulate for the lifetime of the install with nothing referencing them —
 * and a service id reused later would pick up a stranger's icon.
 */
export function deleteCachedIcon(serviceId: string): void {
  // Only ever a uuid from our own config, but this builds a filesystem path, so it is validated
  // like any other — the same rule as the catalog slug guard above.
  if (!/^[A-Za-z0-9-]+$/.test(serviceId)) return;
  for (const ext of FAVICON_EXTENSIONS) {
    try {
      fs.rmSync(path.join(cacheDir(), `${serviceId}.${ext}`), { force: true });
    } catch {
      // A cached icon we can't delete is a wasted few KB, not a failure worth surfacing.
    }
  }
}
