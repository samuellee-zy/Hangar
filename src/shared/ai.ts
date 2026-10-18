import type { InboxReply, InboxSource, SourceRef } from './inbox';

export type EngineId = 'codex' | 'claude';
export interface EngineStatus {
  id: EngineId;
  name: string;
  state: 'unchecked' | 'ready' | 'sign-in' | 'missing' | 'unsupported' | 'error';
  detail: string;
  version?: string;
}
export interface Evidence {
  id: string;
  ref: SourceRef;
  title: string;
  source: string;
  author: string;
  at: number | null;
  retrievedAt: number;
  preview: string;
  read: boolean;
}
export interface AiRun {
  id: string;
  provider: EngineId;
  query: string;
  state: 'running' | 'complete' | 'cancelled' | 'error';
  answer: string;
  progress: string[];
  evidence: Evidence[];
  error: string | null;
}
export interface AiSnapshot {
  providers: EngineStatus[];
  sources: InboxSource[];
  workspaceId: string | null;
  workspaceName: string;
  allWorkspaces: boolean;
  context: { ref: SourceRef; title: string } | null;
  run: AiRun | null;
}
export interface AiStart {
  provider: EngineId;
  query: string;
  sourceIds: string[];
  allWorkspaces: boolean;
  includeContext: boolean;
  /** Set only by the explicitly labelled Search with <provider> action. */
  consent: true;
}
export interface AiBridge {
  snapshot(): Promise<InboxReply<AiSnapshot>>;
  scope(allWorkspaces: boolean): Promise<InboxReply<null>>;
  probe(provider: EngineId): Promise<InboxReply<null>>;
  login(provider: EngineId, mode?: 'subscription' | 'console' | 'sso'): Promise<InboxReply<null>>;
  logout(provider: EngineId): Promise<InboxReply<null>>;
  start(request: AiStart): Promise<InboxReply<null>>;
  cancel(): Promise<InboxReply<null>>;
  clear(): Promise<InboxReply<null>>;
  openCitation(id: string): Promise<InboxReply<null>>;
  onChanged(fn: () => void): () => void;
}
