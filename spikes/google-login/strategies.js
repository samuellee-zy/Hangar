// The Phase 0 fallback ladder, in the order the plan says to try them.
//
// Each strategy gets `ua` (the raw Electron default) and returns how to configure a session.
// Anything omitted is left at Electron's default.
//
//   userAgent     — string applied via session.setUserAgent()
//   hostUserAgent — { <hostname-substring>: ua } applied per-navigation, overriding userAgent
//   clientHints   — inject Sec-CH-UA* request headers + patch navigator.userAgentData
//   loginWindow   — do the sign-in in a real BrowserWindow sharing the partition

// A stock macOS Chrome UA, used by the strategies that stop pretending to be Electron at all.
const PURE_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/150.0.0.0 Safari/537.36';

// Verbatim from Rambox 2.7.0's main.js. Note it strips ONLY the Electron token and leaves the
// app name (`Rambox/2.7.0`) in place — so ours keeps `Hangar/0.1.0`. Don't "improve" this.
const ramboxScrub = (ua) => ua.replace(/Electron\/([0-9]\.?)+\s/gi, '');

const strategies = [
  {
    id: 'baseline',
    name: '0 · Baseline (untouched Electron UA)',
    note: 'Control. Expected to FAIL — if this passes, Google stopped checking.',
    apply: () => ({}),
  },
  {
    id: 'rambox',
    name: '1 · Rambox scrub (strip Electron token only)',
    note: "Rambox 2.7.0's exact production code. Try this alone, first.",
    apply: (ua) => ({ userAgent: ramboxScrub(ua) }),
  },
  {
    id: 'strip-all',
    name: '2 · Strip Electron token + app name',
    note: 'Only if #1 fails. Leaves a bare Chrome UA.',
    apply: (ua) => ({
      userAgent: ramboxScrub(ua).replace(/Hangar\/[\d.]+\s/gi, ''),
    }),
  },
  {
    id: 'pure-chrome',
    name: '3 · Per-service override (hardcoded Chrome UA)',
    note: "Ferdium's manual workaround, productized. Rambox has this too (appPreset.forceUA).",
    apply: () => ({ userAgent: PURE_CHROME }),
  },
  {
    id: 'host-swap',
    name: '4 · Host-scoped swap (Chrome UA on accounts.google.com only)',
    note: 'Rambox scrub everywhere, pure Chrome only on the sign-in host.',
    apply: (ua) => ({
      userAgent: ramboxScrub(ua),
      hostUserAgent: {
        'accounts.google.com': PURE_CHROME,
        'login.microsoftonline.com': PURE_CHROME,
        'login.salesforce.com': PURE_CHROME,
      },
    }),
  },
  {
    id: 'login-window',
    name: '5 · Real BrowserWindow for login',
    note: 'Sign in inside a top-level window sharing the partition, not an embedded child view.',
    apply: (ua) => ({ userAgent: ramboxScrub(ua), loginWindow: true }),
  },
  {
    id: 'client-hints',
    name: '7 · Rambox scrub + aligned client hints',
    note:
      'Contingency. electron#34762: high-entropy UA-CH never send. Rambox ships without this, ' +
      'so it should be unnecessary — we measure whether that holds.',
    apply: (ua) => ({ userAgent: ramboxScrub(ua), clientHints: true }),
  },
];

// Sent as Sec-CH-UA* request headers AND mirrored into navigator.userAgentData by the preload,
// so the headers and the JS surface agree. A mismatch between them is itself a detection signal.
const CLIENT_HINTS = {
  brands: [
    { brand: 'Not:A-Brand', version: '24' },
    { brand: 'Chromium', version: '150' },
    { brand: 'Google Chrome', version: '150' },
  ],
  mobile: false,
  platform: 'macOS',
  platformVersion: '15.5.0',
  architecture: 'arm',
  bitness: '64',
  model: '',
  uaFullVersion: '150.0.7871.114',
};

const headerList = (brands) =>
  brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');

const clientHintHeaders = () => ({
  'Sec-CH-UA': headerList(CLIENT_HINTS.brands),
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': `"${CLIENT_HINTS.platform}"`,
  'Sec-CH-UA-Platform-Version': `"${CLIENT_HINTS.platformVersion}"`,
  'Sec-CH-UA-Arch': `"${CLIENT_HINTS.architecture}"`,
  'Sec-CH-UA-Bitness': `"${CLIENT_HINTS.bitness}"`,
  'Sec-CH-UA-Model': '""',
  'Sec-CH-UA-Full-Version': `"${CLIENT_HINTS.uaFullVersion}"`,
  'Sec-CH-UA-Full-Version-List': headerList(
    CLIENT_HINTS.brands.map((b) => ({
      brand: b.brand,
      version: b.brand === 'Not:A-Brand' ? '24.0.0.0' : CLIENT_HINTS.uaFullVersion,
    }))
  ),
});

module.exports = { strategies, CLIENT_HINTS, clientHintHeaders, PURE_CHROME };
