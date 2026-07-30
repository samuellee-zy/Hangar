// Failure handling. The risk here is over-reacting: `did-fail-load` fires far more often than
// anything is actually broken, and an error page shown over a working service is worse than no
// error handling at all.
//
// Run: npm run check:recovery

import assert from 'node:assert/strict';
import { MAX_AUTO_RETRIES, decideFailure, errorPageHtml, shouldRecoverFromCrash } from '../out-check/recovery.mjs';

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks++;
  console.log(`  ✓ ${label}`);
};

const fail = (over = {}) => decideFailure({ errorCode: -105, isMainFrame: true, attempts: 0, ...over });

console.log('what counts as a failure');

ok('ERR_ABORTED (-3) IS IGNORED — it fires on ordinary superseded navigations', () => {
  // Redirects, clicking through during load, an SPA replacing a pending request. Treating this as
  // an error makes Gmail flash an error page during normal use.
  assert.deepEqual(fail({ errorCode: -3 }), { showError: false, retryAfterMs: null });
});

ok('a subframe failure is ignored — an ad iframe dying is not the page dying', () => {
  assert.deepEqual(fail({ isMainFrame: false }), { showError: false, retryAfterMs: null });
});

ok('a subframe abort is doubly ignored', () => {
  assert.deepEqual(fail({ errorCode: -3, isMainFrame: false }), {
    showError: false,
    retryAfterMs: null,
  });
});

console.log('retry policy');

ok('a transient network error retries rather than showing an error page', () => {
  const action = fail({ errorCode: -106, attempts: 0 });
  assert.equal(action.showError, false);
  assert.equal(action.retryAfterMs, 1000);
});

ok('backoff doubles, so a flapping connection is not hammered', () => {
  assert.equal(fail({ attempts: 0 }).retryAfterMs, 1000);
  assert.equal(fail({ attempts: 1 }).retryAfterMs, 2000);
  assert.equal(fail({ attempts: 2 }).retryAfterMs, 4000);
});

ok('after the cap it gives up and shows the error, rather than retrying forever', () => {
  const action = fail({ attempts: MAX_AUTO_RETRIES });
  assert.equal(action.retryAfterMs, null);
  assert.equal(action.showError, true);
});

ok('a non-transient error shows the error page immediately — retrying a 404 is pointless', () => {
  const action = fail({ errorCode: -6, attempts: 0 }); // FILE_NOT_FOUND
  assert.equal(action.showError, true);
  assert.equal(action.retryAfterMs, null);
});

console.log('crash recovery');

ok('a crashed renderer is reloaded once', () => {
  assert.equal(shouldRecoverFromCrash(0, 'crashed'), true);
});

ok('CLEAN-EXIT IS NOT A CRASH — hibernation and pane close must not trigger a reload', () => {
  // We close these views ourselves; reloading them would defeat hibernation entirely.
  assert.equal(shouldRecoverFromCrash(0, 'clean-exit'), false);
});

ok('a crash loop stops after the cap', () => {
  assert.equal(shouldRecoverFromCrash(MAX_AUTO_RETRIES, 'crashed'), false);
});

console.log('error page');

ok('the page escapes interpolated values', () => {
  const html = decodeURIComponent(
    errorPageHtml({
      serviceName: '<img src=x onerror=alert(1)>',
      url: 'https://example.com/"><script>',
      errorCode: -2,
      description: 'nope',
      offline: false,
    })
  );
  assert.ok(!html.includes('<img src=x'), 'service name is escaped');
  assert.ok(!html.includes('"><script>'), 'url is escaped');
  assert.ok(html.includes('&lt;img'), 'escaped form present');
});

ok('offline gets its own wording rather than a raw error code', () => {
  const offline = decodeURIComponent(
    errorPageHtml({ serviceName: 'Gmail', url: 'u', errorCode: -106, description: '', offline: true })
  );
  assert.ok(offline.includes("You're offline"));
  assert.ok(!offline.includes('-106'), 'no error code shown when the cause is obvious');
});

ok('the retry button calls through the preload bridge', () => {
  const html = decodeURIComponent(
    errorPageHtml({ serviceName: 'X', url: 'u', errorCode: -2, description: 'd', offline: false })
  );
  assert.ok(html.includes('__hangar') && html.includes('retry()'));
});

console.log(`\n${checks} checks passed`);
