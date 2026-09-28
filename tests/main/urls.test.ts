// What may leave the app, and what counts as the app's own screen. Both are security boundaries:
// the first stops a page reaching `file:` or System Settings through the OS, the second stops a
// dropped link from taking over the view that holds `window.hangar`.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  isBlankPage,
  createRateLimiter,
  externalOpenDecision,
  isAppRendererUrl,
  isWebUrl,
  redactUrl,
} from '@core/runtime/urls';

const opens = (url: string) => externalOpenDecision(url).open;

describe('what may be handed to the operating system', () => {
  it('the web, mail, phone and the meeting apps a calendar invite hands off to', () => {
    for (const url of [
      'https://example.com/',
      'http://example.com/',
      'mailto:someone@example.com',
      'tel:+441234567890',
      'zoommtg://zoom.us/join?confno=123',
      'msteams:/l/meetup-join/abc',
      'slack://open',
    ]) {
      assert.equal(opens(url), true, url);
    }
  });

  it('NOT file:, which launches apps and opens documents', () => {
    assert.equal(opens('file:///Applications/Calculator.app'), false);
    assert.equal(opens('file:///etc/passwd'), false);
  });

  it('NOT System Settings, network shares, or script', () => {
    for (const url of [
      'x-apple.systempreferences:com.apple.preference.security',
      'smb://fileserver/share',
      'afp://fileserver/share',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'about:blank',
      'blob:https://example.com/uuid',
      'ssh://host',
      'vnc://host',
    ]) {
      assert.equal(opens(url), false, url);
    }
  });

  it('says why, so the log line is useful', () => {
    const decision = externalOpenDecision('smb://server/share');
    assert.equal(decision.open, false);
    assert.match((decision as { reason: string }).reason, /smb:/);
  });

  it('nonsense and hostless web URLs are refused', () => {
    assert.equal(opens('not a url'), false);
    assert.equal(opens('http://'), false);
  });
});

describe('isWebUrl', () => {
  it('http(s) with a host, and nothing else', () => {
    assert.equal(isWebUrl('https://example.com/x'), true);
    assert.equal(isWebUrl('http://127.0.0.1:3000/'), true);
    assert.equal(isWebUrl('file:///x'), false);
    assert.equal(isWebUrl('about:blank'), false);
    assert.equal(isWebUrl('data:text/html,x'), false);
    assert.equal(isWebUrl(''), false);
  });
});

describe("the app's own screens", () => {
  const built = { indexFile: '/Applications/Hangar.app/Contents/Resources/app.asar/out/renderer/index.html' };
  const dev = { devUrl: 'http://localhost:5173/', indexFile: '/irrelevant' };

  it('the built renderer, on any route', () => {
    const base = 'file:///Applications/Hangar.app/Contents/Resources/app.asar/out/renderer/index.html';
    assert.equal(isAppRendererUrl(`${base}#rail`, built), true);
    assert.equal(isAppRendererUrl(`${base}#settings`, built), true);
  });

  it('A DROPPED FILE IS NOT THE APP — file: matches on the exact path, not the scheme', () => {
    assert.equal(isAppRendererUrl('file:///Users/alice/Downloads/evil.html', built), false);
    assert.equal(
      isAppRendererUrl('file:///Applications/Hangar.app/Contents/Resources/app.asar/out/renderer/other.html', built),
      false,
    );
  });

  it('a dropped web link is not the app', () => {
    assert.equal(isAppRendererUrl('https://example.com/', built), false);
    assert.equal(isAppRendererUrl('https://example.com/', dev), false);
  });

  it('in development, the dev server origin and nothing else', () => {
    assert.equal(isAppRendererUrl('http://localhost:5173/#rail', dev), true);
    assert.equal(isAppRendererUrl('http://localhost:5174/#rail', dev), false);
    assert.equal(isAppRendererUrl('file:///Applications/Hangar.app/x/index.html', dev), false);
  });

  it('percent-encoded paths match — a space in the install path is %20 in the URL', () => {
    const spaced = { indexFile: '/Users/alice/My Apps/Hangar.app/out/renderer/index.html' };
    assert.equal(isAppRendererUrl('file:///Users/alice/My%20Apps/Hangar.app/out/renderer/index.html#rail', spaced), true);
  });
});

describe('the rate limiter', () => {
  it('allows up to max per window, per key, then refuses until the window moves on', () => {
    let t = 0;
    const allow = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    assert.equal(allow('gmail'), true);
    assert.equal(allow('gmail'), true);
    assert.equal(allow('gmail'), false, 'third inside the window');
    assert.equal(allow('slack'), true, 'another key has its own budget');
    t = 1001;
    assert.equal(allow('gmail'), true, 'window has moved on');
  });
});

describe('redactUrl', () => {
  it('KEEPS WHERE, DROPS WHAT — sign-in query strings carry email addresses and nonces', () => {
    assert.equal(
      redactUrl('https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?login_hint=alice%40example.com&state=xyz'),
      'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?…',
    );
    assert.equal(redactUrl('https://example.com/inbox'), 'https://example.com/inbox');
    assert.equal(redactUrl('https://example.com/#token=abc'), 'https://example.com/?…');
  });

  it('schemes without a host read sensibly', () => {
    assert.equal(redactUrl('mailto:someone@example.com'), 'mailto:someone@example.com');
  });
});

describe('a blank page', () => {
  it("IS A WINDOW A PAGE DRAWS INTO ITSELF — Slack's huddle opens as one", () => {
    for (const url of ['about:blank', 'ABOUT:BLANK', 'about:blank#huddle', 'about:blank?x=1', '', '  ']) {
      assert.equal(isBlankPage(url), true, JSON.stringify(url));
    }
  });

  it('and nothing else is', () => {
    for (const url of ['about:srcdoc', 'about:blankish', 'https://app.slack.com/', 'data:text/html,x', undefined]) {
      assert.equal(isBlankPage(url), false, String(url));
    }
  });
});

