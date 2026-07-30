// Headless half of the Phase 0 gate.
//
// Google decides whether a client is an "embedded webview" from the request, before any
// credentials are involved — so we can measure most of the strategy ladder without typing a
// password anywhere. Two probes per strategy:
//
//   signin  — accounts.google.com sign-in page. Serves the "browser or app may not be secure"
//             interstitial to clients it dislikes.
//   oauth   — the OAuth 2.0 authorization endpoint, which is the surface with the hard block.
//             Rejects with error=disallowed_useragent. Uses Google's own published
//             installed-app client id (the gcloud CLI's), so this is a real request shape.
//
// A clean result means "not rejected at these checkpoints" — the interactive harness
// (npm start) is still what confirms an actual end-to-end sign-in that survives a relaunch.
//
// Run: npm run probe

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { strategies, clientHintHeaders } = require('./strategies');

app.setPath('userData', path.join(__dirname, 'sessions-headless'));
app.commandLine.appendSwitch('disable-gpu');

// We destroy each probe window before opening the next, which would otherwise trip Electron's
// default "last window closed → quit" and end the run after the first probe.
app.on('window-all-closed', () => {});

const GCLOUD_CLIENT_ID = '32555940559.apps.googleusercontent.com';

const PROBES = [
  {
    id: 'signin',
    url: 'https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/mail/u/0/',
  },
  {
    id: 'oauth',
    url:
      'https://accounts.google.com/o/oauth2/v2/auth' +
      `?client_id=${GCLOUD_CLIENT_ID}` +
      '&redirect_uri=http%3A%2F%2F127.0.0.1%3A8085%2F' +
      '&response_type=code' +
      '&scope=email' +
      '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' +
      '&code_challenge_method=S256',
  },
];

const BLOCK = [
  /this browser or app may not be secure/i,
  /couldn.{0,3}t sign you in/i,
  /disallowed_useragent/i,
  /try using a different browser/i,
];

const PROBE_JS = `(() => ({
  url: location.href,
  title: document.title,
  text: (document.body && document.body.innerText || '').slice(0, 2000),
  ua: navigator.userAgent,
}))()`;

async function run(strategy, probe, defaultUa) {
  // Persistent partitions rather than in-memory ones: in-memory sessions get torn down as soon
  // as the last window referencing them goes away, which races the destroy below and trips a
  // fatal assert. `npm run reset` wipes sessions-headless/ anyway.
  const partition = `persist:probe-${strategy.id}-${probe.id}`;
  const ses = session.fromPartition(partition);
  const cfg = strategy.apply(defaultUa);

  if (cfg.userAgent) ses.setUserAgent(cfg.userAgent);

  if (cfg.hostUserAgent || cfg.clientHints) {
    const hints = cfg.clientHints ? clientHintHeaders() : null;
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const headers = { ...details.requestHeaders };
      if (cfg.hostUserAgent) {
        for (const [host, ua] of Object.entries(cfg.hostUserAgent)) {
          if (details.url.includes(host)) headers['User-Agent'] = ua;
        }
      }
      if (hints) Object.assign(headers, hints);
      cb({ requestHeaders: headers });
    });
  }

  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition, contextIsolation: true, sandbox: false },
  });

  let info;
  try {
    await win.loadURL(probe.url);
    await new Promise((r) => setTimeout(r, 1500)); // let client-side redirects settle
    info = await win.webContents.executeJavaScript(PROBE_JS, true);
  } catch (err) {
    info = { url: probe.url, title: '', text: `LOAD ERROR: ${err.message}`, ua: cfg.userAgent || defaultUa };
  } finally {
    // Quiesce before tearing down — destroying while subresources are still in flight fires
    // webRequest callbacks against a dead context.
    try {
      win.webContents.stop();
      await new Promise((r) => setTimeout(r, 250));
    } catch {}
    if (!win.isDestroyed()) win.destroy();
    await new Promise((r) => setTimeout(r, 250));
  }

  const hit = BLOCK.find((p) => p.test(info.text) || p.test(info.url));
  return { blocked: Boolean(hit), pattern: hit ? String(hit) : null, ...info };
}

app.whenReady().then(async () => {
  const defaultUa = session.defaultSession.getUserAgent();
  const rows = [];

  console.log(`\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}`);
  console.log(`Default UA:\n  ${defaultUa}\n`);

  for (const strategy of strategies) {
    const row = { strategy: strategy.id, name: strategy.name };
    for (const probe of PROBES) {
      let r;
      try {
        r = await run(strategy, probe, defaultUa);
      } catch (err) {
        r = { blocked: false, error: err.message, url: probe.url, text: '', ua: '' };
      }
      row[probe.id] = r.error ? 'ERROR' : r.blocked ? 'BLOCKED' : 'ok';
      row[`${probe.id}_detail`] = r;
      console.log(
        `${strategy.id.padEnd(13)} ${probe.id.padEnd(7)} ${row[probe.id].padEnd(8)} ${r.url.slice(0, 90)}`
      );
      if (r.blocked) console.log(`${''.padEnd(22)}↳ ${r.text.split('\n').filter(Boolean)[0] || ''}`);
    }
    row.ua = row.signin_detail?.ua || '';
    rows.push(row);
    // Flush as we go so a mid-run crash still leaves usable data.
    fs.writeFileSync(path.join(__dirname, 'probe-results.json'), JSON.stringify(rows, null, 2));
  }

  console.log('\n| Strategy | accounts.google.com | OAuth endpoint |');
  console.log('| --- | --- | --- |');
  for (const r of rows) console.log(`| ${r.name} | ${r.signin} | ${r.oauth} |`);

  fs.writeFileSync(path.join(__dirname, 'probe-results.json'), JSON.stringify(rows, null, 2));
  console.log('\nWrote probe-results.json');
  app.quit();
});
