/** A public client ID identifies Hangar, not the signed-in user. Never bundle confidential app secrets. */
declare const __HANGAR_SLACK_CLIENT_ID__: string;
export interface ProviderRegistration { clientId: string }
export type ProviderRegistrations = Partial<Record<'slack' | 'gmail', ProviderRegistration>>;
export function shippedRegistrations(): ProviderRegistrations {
  const clientId = typeof __HANGAR_SLACK_CLIENT_ID__ === 'string' ? __HANGAR_SLACK_CLIENT_ID__ : '';
  return /^[a-zA-Z0-9._-]{3,250}$/.test(clientId) ? { slack: { clientId } } : {};
}
