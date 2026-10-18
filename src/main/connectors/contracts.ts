import type { InboxItem, InboxThread, SourceKind, SourceRef } from '@shared/inbox';

export interface Connection {
  id: string;
  serviceId: string;
  kind: Exclude<SourceKind, 'page'>;
  identity: string;
  remoteId: string;
  userId: string;
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
export interface ConnectorPage { items: InboxItem[]; cursor: string | null; detail: string }
export interface ReadConnector {
  list(connection: Connection, signal: AbortSignal, cursor?: string): Promise<ConnectorPage>;
  search(connection: Connection, query: string, signal: AbortSignal): Promise<ConnectorPage>;
  read(connection: Connection, ref: SourceRef, signal: AbortSignal): Promise<InboxThread>;
  sourceUrl(connection: Connection, ref: SourceRef): string;
}
export class ConnectorError extends Error {
  constructor(message: string, readonly reconnect = false) { super(message); }
}
