import { object, string } from '@core/inbox/policy';
import { ConnectorError } from './contracts';

export type Fetcher = typeof fetch;
/** Retry-After is shared across requests, so Refresh cannot hammer a rate-limited method. */
export class ConnectorHttp {
  private backoff = new Map<string, number>();
  constructor(private readonly request: Fetcher = fetch) {}
  async json(url: string, init: RequestInit, budgetKey: string): Promise<Record<string, unknown>> {
    if ((this.backoff.get(budgetKey) ?? 0) > Date.now()) throw new ConnectorError('Rate limited. Please try again after a short pause.');
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(20_000)]);
    const response = await this.request(url, { ...init, signal, redirect: 'error' });
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      this.backoff.set(budgetKey, Date.now() + Math.max(1, Number.isFinite(seconds) ? seconds : 60) * 1_000);
      throw new ConnectorError('Rate limited. Please try again after a short pause.');
    }
    if (response.status === 401) throw new ConnectorError('Your connection has expired. Reconnect this account.', true);
    if (response.status === 403) throw new ConnectorError('Access was denied. Check the account permissions.', true);
    if (!response.ok) throw new ConnectorError('The source is unavailable. Please try again.');
    // Bound bytes as well as normalized fields: a body cannot exhaust the main process heap.
    const reader = response.body?.getReader();
    if (!reader) throw new ConnectorError('The source returned an empty response.');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8_000_000) throw new ConnectorError('This response is too large to preview. Open it in the source app.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const data = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (data.ok === false || data.error) {
      const error = string(data.error);
      if (['invalid_auth', 'token_expired', 'token_revoked', 'not_authed', 'invalid_grant'].includes(error)) {
        throw new ConnectorError('Your connection has expired. Reconnect this account.', true);
      }
      if (error === 'missing_scope') throw new ConnectorError('This account needs additional read permissions. Reconnect it.', true);
      throw new ConnectorError('The source could not complete this request. Check your connection and permissions.');
    }
    return data;
  }
}
