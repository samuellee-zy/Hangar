/** Native redirect shared by the registered Slack app and Hangar's protocol handler. */
export const SLACK_REDIRECT_URI = 'hangar://oauth/slack';

/** Only a pending, state-matched login can consume a callback. Nothing is persisted or logged. */
export class NativeOAuthCallbacks {
  private pending = new Map<string, (code: string | null) => void>();

  listen(state: string, receive: (code: string | null) => void): () => void {
    if (this.pending.has(state)) throw new Error('OAuth state is already pending.');
    this.pending.set(state, receive);
    return () => { if (this.pending.get(state) === receive) this.pending.delete(state); };
  }

  accept(raw: string): 'accepted' | 'ignored' | false {
    if (raw.length > 8192) return false;
    let url: URL;
    try { url = new URL(raw); } catch { return false; }
    if (url.protocol !== 'hangar:' || url.hostname !== 'oauth' || url.pathname !== '/slack') return false;
    if (url.username || url.password || url.port || url.hash) return 'ignored';
    const params = url.searchParams;
    if (params.getAll('state').length !== 1 || params.getAll('code').length > 1 || params.getAll('error').length > 1) return 'ignored';
    const state = params.get('state')!;
    const receive = this.pending.get(state);
    if (!receive) return 'ignored';
    const code = params.get('code');
    if (params.has('error') && code) return 'ignored';
    if (!params.has('error') && (!code || code.length > 4096)) return 'ignored';
    this.pending.delete(state);
    receive(params.has('error') ? null : code);
    return 'accepted';
  }
}

export const nativeOAuthCallbacks = new NativeOAuthCallbacks();
