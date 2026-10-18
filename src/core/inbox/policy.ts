import type { InboxItem, SourceRef } from '@shared/inbox';

export const itemId = (ref: SourceRef): string => JSON.stringify([ref.connectionId, ref.threadId]);
export function mergeItems(items: InboxItem[], limit = 500): InboxItem[] {
  const byId = new Map<string, InboxItem>();
  for (const item of items) {
    const previous = byId.get(item.id);
    if (!previous || (item.at ?? 0) > (previous.at ?? 0)) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.id.localeCompare(b.id)).slice(0, limit);
}
export const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const string = (v: unknown, max = 20_000): string => typeof v === 'string' ? v.slice(0, max) : '';
export const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export function isRef(v: unknown): v is SourceRef {
  const r = object(v);
  return typeof r.connectionId === 'string' && r.connectionId.length > 0 && r.connectionId.length < 200
    && typeof r.threadId === 'string' && r.threadId.length > 0 && r.threadId.length < 500;
}
export function isQuery(v: unknown): v is { allWorkspaces: boolean } {
  return typeof object(v).allWorkspaces === 'boolean';
}
export function validConnect(v: unknown): boolean {
  const r = object(v);
  return typeof r.serviceId === 'string' && r.serviceId.length < 200
    && typeof r.clientId === 'string' && /^[a-zA-Z0-9._-]{3,250}$/.test(r.clientId)
    && (r.clientSecret === undefined || (typeof r.clientSecret === 'string' && r.clientSecret.length < 500));
}
