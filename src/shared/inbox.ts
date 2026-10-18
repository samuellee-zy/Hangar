/** Message data travels only to the inbox/assistant surfaces, never ShellState or config sync. */
export type SourceKind = 'slack' | 'gmail' | 'page';
export type InboxCategory = 'direct' | 'mentions' | 'email' | 'channels' | 'other';
export const INBOX_CATEGORIES: Record<InboxCategory, string> = {
  direct: 'Direct messages', mentions: 'Mentions', email: 'Email', channels: 'Channel activity', other: 'Other',
};
export interface SourceRef {
  connectionId: string;
  threadId: string;
}
export interface InboxItem {
  id: string;
  ref: SourceRef;
  title: string;
  preview: string;
  author: string;
  at: number | null;
  unread: boolean | null;
  mention: boolean;
  category: InboxCategory;
}
export interface ThreadMessage {
  id: string;
  author: string;
  at: number | null;
  text: string;
}
export interface InboxThread {
  ref: SourceRef;
  title: string;
  messages: ThreadMessage[];
  partial: boolean;
}
export interface InboxSource {
  id: string;
  serviceId: string;
  kind: SourceKind;
  app: string;
  label: string;
  identity: string | null;
  state: 'ready' | 'refreshing' | 'limited' | 'sleeping' | 'connect' | 'reconnect' | 'error';
  detail: string;
  updatedAt: number | null;
  canSearch: boolean;
  canRead: boolean;
  hasMore: boolean;
}
export interface InboxSnapshot {
  sources: InboxSource[];
  items: InboxItem[];
  workspaceId: string | null;
  workspaceName: string;
}
export interface InboxQuery { allWorkspaces: boolean }
export interface InboxConnect {
  serviceId: string;
  clientId: string;
  /** Google Desktop clients may require their issued secret; Slack public clients never do. */
  clientSecret?: string;
}
export type InboxReply<T> = { ok: true; value: T } | { ok: false; error: string };
export interface InboxBridge {
  snapshot(query: InboxQuery): Promise<InboxReply<InboxSnapshot>>;
  refresh(query: InboxQuery): Promise<InboxReply<null>>;
  more(connectionId: string): Promise<InboxReply<null>>;
  read(ref: SourceRef): Promise<InboxReply<InboxThread>>;
  open(ref: SourceRef): Promise<InboxReply<null>>;
  connect(input: InboxConnect): Promise<InboxReply<null>>;
  disconnect(connectionId: string): Promise<InboxReply<null>>;
  cancelConnect(): Promise<InboxReply<null>>;
  onChanged(fn: () => void): () => void;
}
