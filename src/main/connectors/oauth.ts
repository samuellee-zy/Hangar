import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { object, string } from '@core/inbox/policy';
import { ConnectorError, type Connection } from './contracts';
import type { InboxConnect } from '@shared/inbox';
import { ConnectorHttp } from './http';

const SLACK_SCOPE = 'search:read,channels:history,groups:history,im:history,mpim:history';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url') };
}

/** A single-use loopback callback. Wrong state/path requests do not consume the pending login. */
export async function authorize(
  kind: Connection['kind'], input: InboxConnect, signal: AbortSignal,
  open: (url: string) => Promise<void>, http: ConnectorHttp,
): Promise<Connection> {
  const { verifier, challenge, state } = pkce();
  signal.throwIfAborted();
  let accept: (value: string) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const code = new Promise<string>((resolve, fail) => { accept = resolve; reject = fail; });
  // Attach immediately: cancellation/browser errors can arrive before we await this promise.
  void code.catch(() => {});
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    if (request.method !== 'GET' || url.pathname !== '/oauth/callback' || url.searchParams.get('state') !== state) {
      response.writeHead(400).end('Invalid sign-in callback.');
      return;
    }
    const value = url.searchParams.get('code');
    if (!value || value.length > 4096 || url.searchParams.has('error')) {
      response.end('Sign-in cancelled. Return to Hangar.');
      reject(new ConnectorError('Sign-in was cancelled.'));
    } else {
      response.end('Sign-in received. You can return to Hangar.');
      accept(value);
    }
  });
  const cancel = () => reject(new ConnectorError('Sign-in was cancelled.'));
  const timer = setTimeout(() => reject(new ConnectorError('Sign-in timed out. Please try again.')), 180_000);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    // Slack requires a registered redirect. Google Desktop clients support a random loopback port.
    await new Promise<void>((resolve, fail) => {
      server.once('error', fail);
      server.listen(kind === 'slack' ? 53682 : 0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new ConnectorError('Unable to start the sign-in callback.');
    const redirect = `http://${kind === 'slack' ? 'localhost' : '127.0.0.1'}:${address.port}/oauth/callback`;
    const params = new URLSearchParams({ client_id: input.clientId, response_type: 'code', redirect_uri: redirect, state,
      code_challenge: challenge, code_challenge_method: 'S256' });
    if (kind === 'slack') params.set('user_scope', SLACK_SCOPE);
    else {
      params.set('scope', GMAIL_SCOPE);
      params.set('access_type', 'offline');
      params.set('prompt', 'consent select_account');
    }
    signal.throwIfAborted();
    await open(`${kind === 'slack' ? 'https://slack.com/oauth/v2/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth'}?${params}`);
    const body = new URLSearchParams({ client_id: input.clientId, grant_type: 'authorization_code', code: await code,
      code_verifier: verifier, redirect_uri: redirect });
    if (kind === 'gmail' && input.clientSecret) body.set('client_secret', input.clientSecret);
    const result = await http.json(tokenUrl(kind), { method: 'POST', body, signal }, `oauth:${kind}`);
    const tokens = kind === 'slack' ? object(result.authed_user) : result;
    const accessToken = string(tokens.access_token, 8192);
    if (!accessToken) throw new ConnectorError('The provider did not grant a user connection.');
    const connection: Connection = { id: randomUUID(), kind, serviceId: input.serviceId, identity: '', remoteId: '', userId: '',
      clientId: input.clientId, ...(kind === 'gmail' && input.clientSecret ? { clientSecret: input.clientSecret } : {}),
      accessToken, refreshToken: string(tokens.refresh_token, 8192), expiresAt: expiry(tokens.expires_in) };
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (kind === 'gmail') {
      const profile = await http.json('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers, signal }, connection.id);
      connection.identity = string(profile.emailAddress, 320);
      connection.remoteId = connection.identity.toLowerCase();
      connection.userId = connection.remoteId;
    } else {
      const profile = await http.json('https://slack.com/api/auth.test', { headers, signal }, connection.id);
      connection.remoteId = string(profile.team_id, 100);
      connection.userId = string(profile.user_id, 100);
      connection.identity = `${string(profile.user, 120)} · ${string(profile.team, 120)}`;
    }
    if (!connection.remoteId || !connection.userId) throw new ConnectorError('The provider did not identify this account.');
    signal.throwIfAborted();
    return connection;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    server.closeAllConnections();
    server.close();
  }
}
const tokenUrl = (kind: Connection['kind']) => kind === 'slack' ? 'https://slack.com/api/oauth.v2.access' : 'https://oauth2.googleapis.com/token';
const expiry = (seconds: unknown) => typeof seconds === 'number' && seconds > 0 ? Date.now() + seconds * 1000 : 0;

export async function refreshToken(connection: Connection, signal: AbortSignal, http: ConnectorHttp): Promise<Connection> {
  if (!connection.expiresAt || connection.expiresAt > Date.now() + 60_000) return connection;
  if (!connection.refreshToken) throw new ConnectorError('Your connection has expired. Reconnect this account.', true);
  const body = new URLSearchParams({ client_id: connection.clientId, grant_type: 'refresh_token', refresh_token: connection.refreshToken });
  if (connection.kind === 'gmail' && connection.clientSecret) body.set('client_secret', connection.clientSecret);
  const result = await http.json(tokenUrl(connection.kind), { method: 'POST', body, signal }, `refresh:${connection.id}`);
  const tokens = result.access_token ? result : object(result.authed_user);
  if (!tokens.access_token) throw new ConnectorError('Please reconnect this account.', true);
  return { ...connection, accessToken: string(tokens.access_token, 8192), refreshToken: string(tokens.refresh_token, 8192) || connection.refreshToken,
    expiresAt: expiry(tokens.expires_in) };
}
