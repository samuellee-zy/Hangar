/** Portable contracts: no Node, Electron, DOM, credentials or presentation dependencies. */
export type ExecutionTarget = 'desktop' | 'ios' | 'android' | 'headless';
export interface Capability { id: string; version: number }
export interface ConnectorManifest {
  id: string;
  provider: string;
  version: string;
  protocolVersion: 1;
  capabilities: readonly Capability[];
  authentication: readonly ('oauth-pkce' | 'device-pairing' | 'session')[];
  /** Only tested targets belong here. A portable contract does not make its adapter portable. */
  executionTargets: readonly ExecutionTarget[];
}
export interface AccountBinding {
  accountId: string;
  provider: string;
  adapterId: string;
  executorId: string;
  target: ExecutionTarget;
  available: boolean;
  generation: number;
  capabilities: readonly Capability[];
}
export interface ResourceRef { accountId: string; kind: string; id: string }
export interface Coverage {
  extent: 'complete' | 'partial' | 'unknown';
  detail: string;
}
export interface Resource<T = unknown> {
  ref: ResourceRef;
  revision: string | null;
  updatedAt: number | null;
  coverage: Coverage;
  payload: T;
}
export interface ResourcePage<T = unknown> { items: Resource<T>[]; cursor: string | null; coverage: Coverage }

export interface ConnectorRequest {
  protocolVersion: 1;
  requestId: string;
  accountId: string;
  capability: Capability;
  deadline: number;
  input: unknown;
}
/** Supplied by the trusted caller, never by model arguments or a connector response. */
export interface ConnectorGrant { accountIds: readonly string[]; capabilities: readonly Capability[] }
/** Local execution port. On a wire, cancellation is a separate message keyed by requestId. */
export interface Cancellation { throwIfCancelled(): void }
export interface ConnectorAdapter {
  manifest: ConnectorManifest;
  execute(binding: AccountBinding, request: ConnectorRequest, cancellation: Cancellation): Promise<unknown>;
}
export type ConnectorFailure = 'invalid-request' | 'unsupported' | 'outside-scope' | 'unavailable' | 'expired' | 'invalid-response';
export class CapabilityError extends Error {
  constructor(readonly code: ConnectorFailure, message: string) { super(message); }
}
