import { ConnectorBroker } from '../../src/connectors/broker';
import type { AccountBinding, ConnectorAdapter } from '../../src/connectors/contracts';

// Synthetic resources only. Run the production portable broker inside iOS JavaScriptCore.
const global = globalThis as unknown as { __hangarProbeResult?: string };
void (async () => {
  const read = { id: 'documents.read', version: 1 };
  let binding: AccountBinding | undefined = { accountId: 'a', provider: 'fixture', adapterId: 'fixture', executorId: 'ios', target: 'ios', available: true, generation: 1, capabilities: [read] };
  const adapter: ConnectorAdapter = { manifest: { id: 'fixture', provider: 'fixture', version: '1', protocolVersion: 1, capabilities: [read], authentication: ['oauth-pkce'], executionTargets: ['ios'] },
    execute: async () => ({ ref: { accountId: 'a', kind: 'documents.document', id: 'doc' }, payload: { text: 'Synthetic portable content' } }) };
  const broker = new ConnectorBroker(() => binding, () => 100);
  broker.register(adapter);
  const request = { protocolVersion: 1 as const, requestId: 'r', accountId: 'a', capability: read, deadline: 200, input: { id: 'doc' } };
  const grant = { accountIds: ['a'], capabilities: [read] }, cancellation = { throwIfCancelled() {} };
  const checks: string[] = [];
  const result = await broker.execute(request, grant, cancellation);
  if (JSON.stringify(result).includes('Synthetic portable content')) checks.push('document-read');
  try { await broker.execute(request, { ...grant, accountIds: [] }, cancellation); } catch (error) {
    if ((error as { code: string }).code === 'outside-scope') checks.push('account-denial');
  }
  try { await broker.execute({ ...request, deadline: 99 }, grant, cancellation); } catch (error) {
    if ((error as { code: string }).code === 'expired') checks.push('deadline');
  }
  const pending = broker.execute(request, grant, cancellation);
  binding = undefined;
  try { await pending; } catch (error) {
    if ((error as { code: string }).code === 'unavailable') checks.push('revoked-result');
  }
  global.__hangarProbeResult = JSON.stringify({ ok: checks.length === 4, checks });
})().catch(() => { global.__hangarProbeResult = JSON.stringify({ ok: false, error: 'Portable runtime probe failed' }); });
