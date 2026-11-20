import { CapabilityError, type AccountBinding, type Cancellation, type Capability, type ConnectorAdapter, type ConnectorGrant, type ConnectorRequest } from './contracts';

const supports = (items: readonly Capability[], capability: Capability) => items.some((c) => c.id === capability.id && c.version === capability.version);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

/** Bounded JSON data only; reject executable values, cycles, class instances and non-finite numbers. */
export function isWireValue(value: unknown): boolean {
  let count = 0, characters = 0;
  const visit = (v: unknown, depth: number): boolean => {
    if (++count > 30_000 || depth > 20) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') { characters += v.length; return characters <= 2_000_000; }
    if (Array.isArray(v)) return v.length <= 5000 && v.every((item) => visit(item, depth + 1));
    if (typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return false;
    const entries = Object.entries(v);
    return entries.length <= 500 && entries.every(([key, item]) => visit(key, depth + 1) && visit(item, depth + 1));
  };
  return visit(value, 0);
}

/** Domain-neutral routing. Adding a document/task capability needs no changes to this broker. */
export class ConnectorBroker {
  private readonly adapters = new Map<string, ConnectorAdapter>();
  constructor(private readonly resolve: (accountId: string) => AccountBinding | undefined, private readonly now: () => number) {}
  register(adapter: ConnectorAdapter): void {
    const m = adapter.manifest;
    if (!identifier(m.id) || !identifier(m.provider) || m.protocolVersion !== 1 || this.adapters.has(m.id)
      || m.capabilities.some((c) => !identifier(c.id) || !Number.isInteger(c.version) || c.version < 1)
      || new Set(m.capabilities.map((c) => c.id)).size !== m.capabilities.length) {
      throw new CapabilityError('unsupported', 'Invalid or duplicate connector manifest.');
    }
    this.adapters.set(m.id, adapter);
  }
  async execute(request: ConnectorRequest, grant: ConnectorGrant, cancellation: Cancellation): Promise<unknown> {
    if (request.protocolVersion !== 1 || !identifier(request.requestId) || !identifier(request.accountId)
      || !request.capability || !identifier(request.capability.id) || !Number.isInteger(request.capability.version)
      || !Number.isFinite(request.deadline) || !isWireValue(request.input)) {
      throw new CapabilityError('invalid-request', 'Invalid connector request.');
    }
    const check = () => {
      cancellation.throwIfCancelled();
      if (this.now() >= request.deadline) throw new CapabilityError('expired', 'Connector request expired.');
      if (!grant.accountIds.includes(request.accountId) || !supports(grant.capabilities, request.capability)) {
        throw new CapabilityError('outside-scope', 'This operation is outside the granted account scope.');
      }
      const binding = this.resolve(request.accountId);
      const adapter = binding && this.adapters.get(binding.adapterId);
      if (!binding?.available || binding.accountId !== request.accountId || !adapter) throw new CapabilityError('unavailable', 'This connector is unavailable.');
      if (binding.provider !== adapter.manifest.provider || !adapter.manifest.executionTargets.includes(binding.target)
        || !supports(binding.capabilities, request.capability) || !supports(adapter.manifest.capabilities, request.capability)) {
        throw new CapabilityError('unsupported', 'This account does not support that capability.');
      }
      return { binding, adapter };
    };
    const { binding, adapter } = check();
    const result = await adapter.execute(binding, request, cancellation);
    const latest = check().binding;
    if (binding.generation !== latest.generation || binding.executorId !== latest.executorId || binding.adapterId !== latest.adapterId) {
      throw new CapabilityError('unavailable', 'This connection changed while the request was running.');
    }
    if (!isWireValue(result)) throw new CapabilityError('invalid-response', 'The connector returned invalid or oversized data.');
    return result;
  }
}
