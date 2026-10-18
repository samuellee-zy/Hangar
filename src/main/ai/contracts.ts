import type { EngineId, EngineStatus, Evidence } from '@shared/ai';
import type { ToolSpec } from '@core/ai/policy';

export interface ToolBroker {
  tools: ToolSpec[];
  call(name: string, args: unknown): Promise<unknown>;
}
export type AgentEvent = { type: 'text'; delta: string } | { type: 'status'; text: string } | { type: 'evidence'; evidence: Evidence };
export interface EngineRequest { prompt: string; instructions: string; signal: AbortSignal }
/** Providers own their agent loop; Hangar owns scope, budgets, evidence and lifecycle. */
export interface AgentEngine {
  readonly id: EngineId;
  status(): Promise<EngineStatus>;
  login(mode?: 'subscription' | 'console' | 'sso'): Promise<void>;
  logout(): Promise<void>;
  run(request: EngineRequest, broker: ToolBroker, emit: (event: AgentEvent) => void): Promise<void>;
  dispose(): void;
}
export class AgentError extends Error {}
