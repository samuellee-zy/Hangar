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

/** The cookie `/session` issues and `/api/unread` demands. */
export const SESSION_COOKIE = 'fixture-session';

const PAGES: Record<string, { status?: number; body: string; setCookie?: string }> = {
  '/': {
    body: `<!doctype html><title>Fixture</title>
      <h1 id="heading">Fixture service</h1>
      <a id="external" href="https://example.com/elsewhere">external link</a>
      <p id="findable">The quick brown fox jumps over the lazy dog.</p>`,
  },
  // WhatsApp's chat list, as its unread rule reads it (catalog.ts, WHATSAPP_MESSAGES): a badge per
  // chat, a muted chat's badge just after its muted icon, and a status icon with a label and no
  // number. The title counts chats, as WhatsApp's does.
  '/whatsapp': {
    body: `<!doctype html><title>(2) WhatsApp</title>
      <div id="pane-side"><div aria-label="Chat list">
        <div class="chat"><div class="meta"><span data-icon="pinned2"></span></div>
          <div class="count"><span id="family" aria-label="8 unread messages">8</span></div></div>
        <div class="chat"><div class="meta"><span data-icon="muted"></span></div>
          <div class="count"><span aria-label="3 unread messages">3</span></div></div>
        <div class="chat"><div class="meta"><span aria-label=" Delivered " data-icon="status-dblcheck"></span></div>
          <div class="count"><span aria-label="1 unread message">1</span></div></div>
      </div></div>`,
  },
  // Title-based unread detection reads this shape — see core/notify/unread.ts.
  '/unread': {
    body: `<!doctype html><title>(4) Fixture</title><h1>Four unread</h1>`,
  },
  // A service that keeps its count in the page rather than the title, like most of them. Two
  // badges so a test can move a selector from one to the other and watch the count follow.
  '/badge': {
    body: `<!doctype html><title>Badge fixture</title>
      <div id="app">
        <span class="unread-badge">3</span>
        <span class="other-badge">9</span>
      </div>`,
  },
  // Signing in: the response sets a cookie in whatever partition loaded it. `/api/unread` below
  // refuses anyone who doesn't send it back, which is how a test can tell a session-borrowed
  // request apart from a plain one.
  '/session': {
    body: `<!doctype html><title>Signed in</title><h1>Signed in</h1>`,
    setCookie: `${SESSION_COOKIE}=ok; Path=/`,
  },
  // Blank body: the poller in preload/service.ts should notice and ask main to reload.
  '/blank': { body: `<!doctype html><title>Blank</title><body></body>` },
  '/gone': { status: 404, body: 'not found' },
};


export async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    // The service's own "API". A 401 without the cookie is the entire assertion available to the
    // session-borrowing test: a request that gets 200 here provably carried that partition's jar.
    if (path === '/api/unread') {
      const signedIn = (req.headers.cookie ?? '').includes(`${SESSION_COOKIE}=ok`);
      res.writeHead(signedIn ? 200 : 401, { 'content-type': 'application/json' });
      res.end(signedIn ? JSON.stringify({ counts: { unread: 5 } }) : '{"error":"sign in"}');
      return;
    }

    const page = PAGES[path];
    res.writeHead(page?.status ?? (page ? 200 : 404), {
      'content-type': 'text/html',
      ...(page?.setCookie ? { 'set-cookie': page.setCookie } : {}),
    });
    res.end(page?.body ?? 'not found');
  });

  // Port 0: the OS picks a free one, so parallel runs and a busy machine don't collide.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    // Connections first: `close()` waits for every open one, and a page that is still loading — or
    // a keep-alive socket from a renderer that has not exited yet — would hold teardown open.
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
