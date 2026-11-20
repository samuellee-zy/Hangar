import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ConnectorHttp } from '../../src/main/connectors/http';
import { authorize } from '../../src/main/connectors/oauth';
import { NativeOAuthCallbacks, nativeOAuthCallbacks, SLACK_REDIRECT_URI } from '../../src/main/connectors/oauth-callback';

const callback = (state: string, code = 'test-code') => `${SLACK_REDIRECT_URI}?${new URLSearchParams({ state, code })}`;

describe('native Slack OAuth', () => {
  it('ignores wrong accounts, ambiguous parameters and unsolicited callbacks without consuming a pending sign-in', () => {
    const callbacks = new NativeOAuthCallbacks();
    const receive = vi.fn();
    callbacks.listen('pending-state', receive);
    for (const url of [callback('wrong'), `${callback('pending-state')}&state=other`, `${callback('pending-state')}&code=other`,
      `${callback('pending-state')}&error=denied`, `${callback('pending-state')}#fragment`,
      callback('pending-state').replace('oauth/', 'user@oauth/'), callback('pending-state').replace('/slack', '/gmail')]) {
      callbacks.accept(url);
    }
    expect(receive).not.toHaveBeenCalled();
    expect(callbacks.accept(callback('pending-state'))).toBe('accepted');
    expect(callbacks.accept(callback('pending-state'))).toBe('ignored');
    expect(receive).toHaveBeenCalledExactlyOnceWith('test-code');
  });

  it('exchanges a native authorization once with the matching PKCE verifier and no client secret', async () => {
    let challenge = '';
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('oauth.v2.access')) {
        const body = init!.body as URLSearchParams;
        expect(body.get('redirect_uri')).toBe(SLACK_REDIRECT_URI);
        expect(body.get('client_secret')).toBeNull();
        expect(body.get('code')).toBe('test-code');
        expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(challenge);
        return new Response(JSON.stringify({ ok: true, authed_user: { access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600, scope: 'im:read,im:history,users:read' } }));
      }
      return new Response(JSON.stringify({ ok: true, team_id: 'T123', user_id: 'U123', team: 'Personal', user: 'sam' }));
    });
    const result = await authorize('slack', { serviceId: 'slack', clientId: '123.456' }, new AbortController().signal, async (url) => {
      const auth = new URL(url);
      expect(auth.searchParams.get('redirect_uri')).toBe(SLACK_REDIRECT_URI);
      challenge = auth.searchParams.get('code_challenge')!;
      const response = callback(auth.searchParams.get('state')!);
      expect(nativeOAuthCallbacks.accept(callback('wrong'))).toBe('ignored');
      expect(nativeOAuthCallbacks.accept(response)).toBe('accepted');
      expect(nativeOAuthCallbacks.accept(response)).toBe('ignored');
    }, new ConnectorHttp(request));
    expect(result).toMatchObject({ remoteId: 'T123', userId: 'U123', identity: 'sam · Personal', scopes: ['im:read', 'im:history', 'users:read'] });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('drops cancelled and denied callbacks without exchanging a code', async () => {
    const request = vi.fn();
    const controller = new AbortController();
    let response = '';
    await expect(authorize('slack', { serviceId: 'slack', clientId: '123.456' }, controller.signal, async (url) => {
      response = callback(new URL(url).searchParams.get('state')!);
      controller.abort();
    }, new ConnectorHttp(request))).rejects.toThrow('cancelled');
    expect(nativeOAuthCallbacks.accept(response)).toBe('ignored');
    await expect(authorize('slack', { serviceId: 'slack', clientId: '123.456' }, new AbortController().signal, async (url) => {
      const state = new URL(url).searchParams.get('state')!;
      nativeOAuthCallbacks.accept(`${SLACK_REDIRECT_URI}?${new URLSearchParams({ state, error: 'access_denied' })}`);
    }, new ConnectorHttp(request))).rejects.toThrow('cancelled');
    expect(request).not.toHaveBeenCalled();
  });

  it('expires a pending login and ignores a late browser return', async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn();
      let response = '';
      const pending = authorize('slack', { serviceId: 'slack', clientId: '123.456' }, new AbortController().signal, async (url) => {
        response = callback(new URL(url).searchParams.get('state')!);
      }, new ConnectorHttp(request));
      const rejected = expect(pending).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(180_000);
      await rejected;
      expect(nativeOAuthCallbacks.accept(response)).toBe('ignored');
      expect(request).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
