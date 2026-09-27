// Failure handling. The risk here is over-reacting: `did-fail-load` fires far more often than
// anything is actually broken, and an error page shown over a working service is worse than no
// error handling at all.
//

import { describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  HEALTHY_AFTER_MS,
  MAX_AUTO_RETRIES,
  OFFLINE,
  attemptsSoFar,
  decideFailure,
  errorPageHtml,
  shouldRecoverFromCrash,
} from '@core/runtime/recovery';


const fail = (over = {}) => decideFailure({ errorCode: -105, isMainFrame: true, attempts: 0, ...over });

describe("what counts as a failure", () => {

  it('ERR_ABORTED (-3) IS IGNORED — it fires on ordinary superseded navigations', () => {
    // Redirects, clicking through during load, an SPA replacing a pending request. Treating this as
    // an error makes Gmail flash an error page during normal use.
    assert.deepEqual(fail({ errorCode: -3 }), { showError: false, retryAfterMs: null });
  });

  it('a subframe failure is ignored — an ad iframe dying is not the page dying', () => {
    assert.deepEqual(fail({ isMainFrame: false }), { showError: false, retryAfterMs: null });
  });

  it('a subframe abort is doubly ignored', () => {
    assert.deepEqual(fail({ errorCode: -3, isMainFrame: false }), {
      showError: false,
      retryAfterMs: null,
    });
  });
});

describe("retry policy", () => {

  it('a transient network error retries rather than showing an error page', () => {
    const action = fail({ errorCode: -105, attempts: 0 }); // NAME_NOT_RESOLVED
    assert.equal(action.showError, false);
    assert.equal(action.retryAfterMs, 1000);
  });

  it('OFFLINE WAITS FOR THE NETWORK instead of retrying on a timer that cannot succeed', () => {
    const action = fail({ errorCode: OFFLINE, attempts: 0 });
    assert.equal(action.showError, true, 'says so straight away');
    assert.equal(action.retryAfterMs, null, 'no timer');
    assert.equal(action.waitForNetwork, true, 'reloads itself when the network is back');
  });

  it('backoff doubles, so a flapping connection is not hammered', () => {
    assert.equal(fail({ attempts: 0 }).retryAfterMs, 1000);
    assert.equal(fail({ attempts: 1 }).retryAfterMs, 2000);
    assert.equal(fail({ attempts: 2 }).retryAfterMs, 4000);
  });

  it('after the cap it gives up and shows the error, rather than retrying forever', () => {
    const action = fail({ attempts: MAX_AUTO_RETRIES });
    assert.equal(action.retryAfterMs, null);
    assert.equal(action.showError, true);
  });

  it('a non-transient error shows the error page immediately — retrying a 404 is pointless', () => {
    const action = fail({ errorCode: -6, attempts: 0 }); // FILE_NOT_FOUND
    assert.equal(action.showError, true);
    assert.equal(action.retryAfterMs, null);
  });
});

describe("crash recovery", () => {

  it('a crashed renderer is reloaded once', () => {
    assert.equal(shouldRecoverFromCrash(0, 'crashed'), true);
  });

  it('CLEAN-EXIT IS NOT A CRASH — hibernation and pane close must not trigger a reload', () => {
    // We close these views ourselves; reloading them would defeat hibernation entirely.
    assert.equal(shouldRecoverFromCrash(0, 'clean-exit'), false);
  });

  it('a crash loop stops after the cap', () => {
    assert.equal(shouldRecoverFromCrash(MAX_AUTO_RETRIES, 'crashed'), false);
  });
});

describe("error page", () => {

  it('the page escapes interpolated values', () => {
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

  it('offline gets its own wording rather than a raw error code', () => {
    const offline = decodeURIComponent(
      errorPageHtml({ serviceName: 'Gmail', url: 'u', errorCode: -106, description: '', offline: true })
    );
    assert.ok(offline.includes("You're offline"));
    assert.ok(!offline.includes('-106'), 'no error code shown when the cause is obvious');
  });

  it('the retry button calls through the preload bridge', () => {
    const html = decodeURIComponent(
      errorPageHtml({ serviceName: 'X', url: 'u', errorCode: -2, description: 'd', offline: false })
    );
    assert.ok(html.includes('__hangar') && html.includes('retry()'));
  });
});

describe('when a failure counts against the backoff', () => {
  const t0 = 1_000_000;

  it('THE ERROR PAGE LOADING IS NOT A RECOVERY — the loop that reloaded every second, forever', () => {
    // Chromium commits an error page and fires did-finish-load for it, a moment after the failure.
    const history = { failures: 2, lastFailureAt: t0, lastLoadedAt: t0 + 50 };
    assert.equal(attemptsSoFar(history, t0 + 1_000), 2, 'a second later it is the same outage');
  });

  it('a load that stays up for the healthy period does wipe the slate', () => {
    const history = { failures: 3, lastFailureAt: t0, lastLoadedAt: t0 + 1_000 };
    assert.equal(attemptsSoFar(history, t0 + 1_000 + HEALTHY_AFTER_MS), 0);
  });

  it('a failure after the last load is still counted however long ago the load was', () => {
    const history = { failures: 1, lastFailureAt: t0 + 5_000, lastLoadedAt: t0 };
    assert.equal(attemptsSoFar(history, t0 + 10 * HEALTHY_AFTER_MS), 1);
  });

  it('no history is no attempts', () => {
    assert.equal(attemptsSoFar({ failures: 0, lastFailureAt: null, lastLoadedAt: null }, t0), 0);
  });

  it('THE BACKOFF NOW REACHES ITS CAP — simulating the sequence that used to loop', () => {
    const history = { failures: 0, lastFailureAt: null as number | null, lastLoadedAt: null as number | null };
    let now = t0;
    let retries = 0;
    for (let i = 0; i < 20; i++) {
      const attempts = attemptsSoFar(history, now);
      const action = decideFailure({ errorCode: -105, isMainFrame: true, attempts });
      history.failures = attempts + 1;
      history.lastFailureAt = now;
      if (action.retryAfterMs === null) break;
      retries++;
      history.lastLoadedAt = now + 10; // the error page's did-finish-load
      now += action.retryAfterMs;
    }
    assert.equal(retries, MAX_AUTO_RETRIES, 'stops after the cap instead of looping');
  });
});

describe('the crash page', () => {
  it('names the service and offers the reload the automatic ones ran out of', async () => {
    const { crashedPageHtml } = await import('@core/runtime/recovery');
    const html = decodeURIComponent(crashedPageHtml({ serviceName: 'Slack <3', reason: 'oom' }));
    expect(html).toContain('Slack &lt;3 keeps crashing');
    expect(html).toContain('__hangar.retry()');
    expect(html).toContain('oom');
  });
});

describe('what a failed load says', () => {
  it('IN WORDS, WITH THE HOST — it said ERR_NAME_NOT_RESOLVED (-105) and nothing else', async () => {
    const { explainLoadError, errorPageHtml } = await import('@core/runtime/recovery');
    expect(explainLoadError(-105, 'git.acme.io')).toBe(
      "Couldn't find git.acme.io. Check the address, or whether this Mac can reach it.",
    );
    expect(explainLoadError(-202, 'x.test')).toMatch(/certificate isn't trusted/);
    expect(explainLoadError(-999, 'x.test')).toBe('The page failed to load.');

    const html = decodeURIComponent(
      errorPageHtml({ serviceName: 'GitLab', url: 'https://git.acme.io/', errorCode: -105, description: 'ERR_NAME_NOT_RESOLVED', offline: false }),
    );
    expect(html).toContain("Couldn&#39;t find git.acme.io".replace('&#39;', "'"));
    expect(html).toContain('ERR_NAME_NOT_RESOLVED (-105)'); // still there, in the small print
    expect(html).toContain('openInBrowser()');
  });

  it('offline says it is reconnecting, and offers no browser — that would be offline too', async () => {
    const { errorPageHtml } = await import('@core/runtime/recovery');
    const html = decodeURIComponent(
      errorPageHtml({ serviceName: 'Gmail', url: 'https://mail.google.com/', errorCode: -106, description: '', offline: true }),
    );
    expect(html).toContain('Reconnecting by itself');
    expect(html).not.toContain('openInBrowser()');
  });
});
