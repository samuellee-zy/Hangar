// Phase 0 gate: which UA strategy gets us past Google's embedded-webview block?
//
// Layout is one BaseWindow with two WebContentsViews: a fixed control bar on top and a swappable
// test view below. Every (strategy, service) pair gets its own persistent partition, so a login
// under one strategy can't mask a failure under another.
//
// Run:   npm start          Reset all sessions + results:   npm run reset

const { app, BaseWindow, WebContentsView, BrowserWindow, session, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const { strategies, CLIENT_HINTS, clientHintHeaders } = require('./strategies');
const { promoteSessionCookies, flush } = require('./persist-cookies');
const services = require('./services');

// Keep every partition inside the spike dir so `npm run reset` is a clean slate.
app.setPath('userData', path.join(__dirname, 'sessions'));

const CONTROL_HEIGHT = 168;
const RESULTS_JSON = path.join(__dirname, 'results.json');
const RESULTS_MD = path.join(__dirname, 'results.md');

// Electron's stock UA, captured before anything mutates it. Every strategy derives from this.
let DEFAULT_UA = '';

let win;
let controlView;
let testView = null;
let current = { strategyId: null, serviceId: null };

const results = fs.existsSync(RESULTS_JSON)
  ? JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8'))
  : {};

const key = (strategyId, serviceId) => `${strategyId}::${serviceId}`;
// Services can share a cookie jar with another service (Calendar rides on Gmail's Google session),
// so the partition is keyed on the session owner, not the service.
const partitionFor = (strategyId, serviceId) => {
  const svc = serviceById(serviceId);
  return `persist:${strategyId}--${svc?.sharesSessionWith || serviceId}`;
};
const strategyById = (id) => strategies.find((s) => s.id === id);
const serviceById = (id) => services.find((s) => s.id === id);

const saveResults = () => fs.writeFileSync(RESULTS_JSON, JSON.stringify(results, null, 2));

// --- session wiring -------------------------------------------------------------------------

const liveSessions = new Map(); // partition -> Session

function configureSession(strategyId, serviceId) {
  const partition = partitionFor(strategyId, serviceId);
  const ses = session.fromPartition(partition);
  if (liveSessions.has(partition)) return { ses, partition };
  liveSessions.set(partition, ses);

  const cfg = strategyById(strategyId).apply(DEFAULT_UA);

  if (cfg.userAgent) ses.setUserAgent(cfg.userAgent);

  if (cfg.hostUserAgent || cfg.clientHints) {
    const hints = cfg.clientHints ? clientHintHeaders() : null;
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      if (cfg.hostUserAgent) {
        for (const [host, ua] of Object.entries(cfg.hostUserAgent)) {
          if (details.url.includes(host)) headers['User-Agent'] = ua;
        }
      }
      if (hints) Object.assign(headers, hints);
      callback({ requestHeaders: headers });
    });
  }

  // Sign-in flows lean on popups; without this they silently no-op and look like a block.
  ses.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(['notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission))
  );

  return { ses, partition };
}

// --- detection ------------------------------------------------------------------------------

// Google and Microsoft both render the rejection as an ordinary page, so we read the text rather
// than relying on a status code.
const BLOCK_PATTERNS = [
  /this browser or app may not be secure/i,
  /couldn.{0,3}t sign you in/i,
  /disallowed_useragent/i,
  /try using a different browser/i,
  /we couldn.{0,3}t sign you in/i,
  /browser is not supported/i,
  /unsupported browser/i,
];

const PROBE = `(() => {
  const text = (document.body && document.body.innerText || '').slice(0, 4000);
  return {
    url: location.href,
    title: document.title,
    text,
    ua: navigator.userAgent,
    uaData: navigator.userAgentData
      ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform }
      : null,
  };
})()`;

async function probe() {
  if (!testView || testView.webContents.isDestroyed()) return;
  let info;
  try {
    info = await testView.webContents.executeJavaScript(PROBE, true);
  } catch {
    return; // mid-navigation; the next event will re-probe
  }

  const svc = serviceById(current.serviceId);
  const blockedBy = BLOCK_PATTERNS.find((p) => p.test(info.text) || p.test(info.url));
  const status = {
    ...current,
    url: info.url,
    title: info.title,
    ua: info.ua,
    uaData: info.uaData,
    blocked: Boolean(blockedBy),
    blockedBy: blockedBy ? String(blockedBy) : null,
    signedIn: svc ? svc.signedIn(info.url) : false,
  };

  // Auto-record what we can observe; PASS still requires the human to confirm persistence.
  const k = key(current.strategyId, current.serviceId);
  const rec = (results[k] ??= { strategyId: current.strategyId, serviceId: current.serviceId });
  if (status.blocked) rec.blocked = true;
  if (status.signedIn) {
    // Promote the moment a sign-in lands rather than waiting for the timer — otherwise quitting
    // within the first minute of logging in silently loses the session, which is precisely how
    // Salesforce kept "not surviving".
    if (!rec.signedInSeen) {
      const ses = liveSessions.get(partitionFor(current.strategyId, current.serviceId));
      if (ses) await promoteSessionCookies(ses, { label: `on-signin ${current.serviceId}` });
    }
    rec.signedInSeen = true;
  }
  rec.lastUrl = status.url;
  rec.ua = status.ua;
  saveResults();

  controlView.webContents.send('status', status);
}

// --- views ----------------------------------------------------------------------------------

function testBounds() {
  const { width, height } = win.getContentBounds();
  return { x: 0, y: CONTROL_HEIGHT, width, height: height - CONTROL_HEIGHT };
}

function loadTest(strategyId, serviceId) {
  const svc = serviceById(serviceId);
  const cfg = strategyById(strategyId).apply(DEFAULT_UA);
  const { partition } = configureSession(strategyId, serviceId);
  current = { strategyId, serviceId };

  if (testView) {
    win.contentView.removeChildView(testView);
    testView.webContents.close();
    testView = null;
  }

  testView = new WebContentsView({
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'preload-service.js'),
      // The client-hints strategy needs the preload to mirror the headers into JS.
      additionalArguments: cfg.clientHints
        ? [`--hangar-hints=${Buffer.from(JSON.stringify(CLIENT_HINTS)).toString('base64')}`]
        : [],
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.contentView.addChildView(testView);
  testView.setBounds(testBounds());

  const wc = testView.webContents;
  for (const ev of ['did-finish-load', 'did-navigate', 'did-navigate-in-page', 'did-fail-load']) {
    wc.on(ev, () => setTimeout(probe, 400));
  }
  // Real sign-in flows open popups; keep them in-app and on the same partition.
  wc.setWindowOpenHandler(({ url }) => ({
    action: 'allow',
    overrideBrowserWindowOptions: { webPreferences: { partition }, width: 600, height: 760 },
  }));

  wc.loadURL(svc.url);
}

// Strategy 5: do the sign-in in a top-level window rather than an embedded child view.
function openLoginWindow() {
  if (!current.strategyId) return;
  const { partition } = configureSession(current.strategyId, current.serviceId);
  const svc = serviceById(current.serviceId);
  const w = new BrowserWindow({
    width: 900,
    height: 800,
    webPreferences: { partition, contextIsolation: true, sandbox: false },
  });
  w.loadURL(svc.url);
  w.on('closed', () => testView && testView.webContents.reload());
}

// --- results.md -----------------------------------------------------------------------------

// Delegated to report.js so the interactive and headless halves can't drift apart.
function writeResultsMd() {
  execFileSync(process.execPath, [path.join(__dirname, 'report.js')], {
    cwd: __dirname,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return RESULTS_MD;
}

// --- ipc ------------------------------------------------------------------------------------

ipcMain.handle('config', () => ({
  strategies: strategies.map(({ id, name, note }) => ({ id, name, note })),
  services: services.map(({ id, name, gate }) => ({ id, name, gate })),
  results,
  defaultUa: DEFAULT_UA,
}));

ipcMain.handle('load', (_e, { strategyId, serviceId }) => loadTest(strategyId, serviceId));
ipcMain.handle('reload', () => testView && testView.webContents.reload());
ipcMain.handle('devtools', () => testView && testView.webContents.openDevTools({ mode: 'detach' }));
ipcMain.handle('login-window', openLoginWindow);
ipcMain.handle('probe', probe);

ipcMain.handle('verdict', (_e, { verdict }) => {
  if (!current.strategyId) return null;
  const k = key(current.strategyId, current.serviceId);
  const rec = (results[k] ??= { ...current });
  rec.verdict = verdict;
  rec.recordedAt = new Date().toISOString();
  saveResults();
  return results;
});

ipcMain.handle('clear-session', async () => {
  if (!current.strategyId) return;
  const { ses } = configureSession(current.strategyId, current.serviceId);
  await ses.clearStorageData();
  delete results[key(current.strategyId, current.serviceId)];
  saveResults();
  if (testView) testView.webContents.reload();
});

ipcMain.handle('write-md', () => {
  const p = writeResultsMd();
  shell.showItemInFolder(p);
  return p;
});

// --- boot -----------------------------------------------------------------------------------

app.whenReady().then(() => {
  DEFAULT_UA = session.defaultSession.getUserAgent();

  win = new BaseWindow({ width: 1440, height: 980, title: 'Hangar · Phase 0 login spike' });

  controlView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-control.js'), contextIsolation: true },
  });
  win.contentView.addChildView(controlView);
  controlView.setBounds({ x: 0, y: 0, width: 1440, height: CONTROL_HEIGHT });
  controlView.webContents.loadFile('control.html');

  const layout = () => {
    const { width } = win.getContentBounds();
    controlView.setBounds({ x: 0, y: 0, width, height: CONTROL_HEIGHT });
    if (testView) testView.setBounds(testBounds());
  };
  win.on('resize', layout);
  layout();
});

// --- session durability ------------------------------------------------------------------------
// Salesforce's `sid` is a session cookie, so it never reaches disk and the login dies with the
// process. Promote session cookies to persistent on the way out (and periodically, so an unclean
// kill doesn't lose them either).

async function persistAll() {
  for (const [partition, ses] of liveSessions) {
    await promoteSessionCookies(ses, { label: partition });
    await flush(ses);
  }
}

setInterval(persistAll, 60_000);

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  persistAll().finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
