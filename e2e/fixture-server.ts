import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny local site for the panes to load.
 *
 * Tests must never hit `mail.google.com`. Beyond being slow and flaky, a real service would need a
 * real login, and a test that depends on your Google session is a test that fails on someone
 * else's machine and passes on yours.
 *
 * The pages here are shaped to exercise specific behaviours rather than to look like anything:
 * a title that carries an unread count, a link to an external origin, a page that never finishes
 * loading.
 */
export interface FixtureServer {
  origin: string;
  close: () => Promise<void>;
}

const PAGES: Record<string, { status?: number; body: string }> = {
  '/': {
    body: `<!doctype html><title>Fixture</title>
      <h1 id="heading">Fixture service</h1>
      <a id="external" href="https://example.com/elsewhere">external link</a>
      <p id="findable">The quick brown fox jumps over the lazy dog.</p>`,
  },
  // Title-based unread detection reads this shape — see core/notify/unread.ts.
  '/unread': {
    body: `<!doctype html><title>(4) Fixture</title><h1>Four unread</h1>`,
  },
  // Blank body: the poller in preload/service.ts should notice and ask main to reload.
  '/blank': { body: `<!doctype html><title>Blank</title><body></body>` },
  '/gone': { status: 404, body: 'not found' },
};

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const page = PAGES[(req.url ?? '/').split('?')[0] ?? '/'];
    res.writeHead(page?.status ?? (page ? 200 : 404), { 'content-type': 'text/html' });
    res.end(page?.body ?? 'not found');
  });

  // Port 0: the OS picks a free one, so parallel runs and a busy machine don't collide.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
