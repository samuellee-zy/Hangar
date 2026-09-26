// The proxy preference, as handed to Chromium. Both bugs here left services on the wrong network
// with nothing on screen to say so.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { proxyRules } from '@main/platform/system';

const proxy = (over: Partial<{ mode: string; host: string; port: number }>) =>
  ({ mode: 'system', host: '', port: 0, ...over }) as Parameters<typeof proxyRules>[0];

describe('proxy rules', () => {
  it('SYSTEM ACTIVELY RESTORES THE SYSTEM PROXY — it used to leave the last one in place', () => {
    assert.deepEqual(proxyRules(proxy({ mode: 'system' })), { mode: 'system' });
  });

  it('none is a direct connection', () => {
    assert.deepEqual(proxyRules(proxy({ mode: 'none' })), { mode: 'direct' });
  });

  it('a complete manual proxy becomes a Chromium rule', () => {
    assert.deepEqual(proxyRules(proxy({ mode: 'http', host: 'proxy.corp', port: 8080 })), {
      proxyRules: 'http://proxy.corp:8080',
    });
    assert.deepEqual(proxyRules(proxy({ mode: 'socks5', host: ' 10.0.0.1 ', port: 1080 })), {
      proxyRules: 'socks5://10.0.0.1:1080',
    });
  });

  it('A HALF-FILLED MANUAL PROXY USES THE SYSTEM ONE — "http://:0" cut every service off', () => {
    for (const p of [
      proxy({ mode: 'http' }),
      proxy({ mode: 'http', host: 'proxy.corp' }),
      proxy({ mode: 'socks4', port: 1080 }),
      proxy({ mode: 'http', host: '   ', port: 8080 }),
      proxy({ mode: 'http', host: 'proxy.corp', port: 70000 }),
    ]) {
      assert.deepEqual(proxyRules(p), { mode: 'system' }, JSON.stringify(p));
    }
  });
});
