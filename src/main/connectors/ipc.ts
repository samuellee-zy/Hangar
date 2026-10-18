import { isQuery, isRef, validConnect } from '@core/inbox/policy';
import type { InboxConnect, InboxReply } from '@shared/inbox';
import { ConnectorError } from './contracts';
import type { ConnectorHub } from './hub';

/** Sender ownership is checked in boot before this validated action dispatcher is reached. */
export async function inboxRequest(hub: ConnectorHub, action: unknown, payload: unknown): Promise<InboxReply<unknown>> {
  try {
    let value: unknown = null;
    if (action === 'snapshot' && isQuery(payload)) value = hub.snapshot(payload);
    else if (action === 'refresh' && isQuery(payload)) await hub.refresh(payload);
    else if (action === 'read' && isRef(payload)) value = await hub.read(payload);
    else if (action === 'open' && isRef(payload)) await hub.open(payload);
    else if (action === 'connect' && validConnect(payload)) await hub.connect(payload as InboxConnect);
    else if (action === 'cancelConnect') hub.cancelConnect();
    else if (action === 'disconnect' && typeof payload === 'string' && payload.length < 200) hub.disconnect(payload);
    else if (action === 'more' && typeof payload === 'string' && payload.length < 200) await hub.more(payload);
    else throw new ConnectorError('Invalid inbox request.');
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof ConnectorError ? error.message : 'Unable to complete this action. Check your connection and system keychain, then try again.' };
  }
}
