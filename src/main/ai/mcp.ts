import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { object, string } from '@core/inbox/policy';
import type { ToolBroker } from './contracts';

/** Per-run, authenticated loopback MCP facade. No app control, filesystem or write tools. */
export async function startMcp(broker: ToolBroker): Promise<{ url: string; token: string; close(): void }> {
  const token = randomBytes(32).toString('base64url');
  const server = createServer((request, response) => {
    const handle = async () => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json');
      if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin || request.url !== '/mcp') {
        response.writeHead(403).end(); return;
      }
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      let raw = '';
      for await (const chunk of request) {
        raw += String(chunk);
        if (raw.length > 64_000) { response.writeHead(413).end(); request.destroy(); return; }
      }
      const data = object(JSON.parse(raw)), params = object(data.params);
      if (data.jsonrpc !== '2.0') { response.writeHead(400).end(); return; }
      if (data.id === undefined) { response.writeHead(202).end(); return; }
      let result: unknown;
      if (data.method === 'initialize') result = { protocolVersion: ['2025-03-26', '2025-06-18', '2025-11-25'].includes(string(params.protocolVersion)) ? params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'hangar-search', version: '0.1.0' } };
      else if (data.method === 'ping') result = {};
      else if (data.method === 'tools/list') result = { tools: broker.tools.map((t) => ({ ...t, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })) };
      else if (data.method === 'tools/call') {
        const value = await broker.call(string(params.name, 100), params.arguments);
        result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: Boolean(object(value).error) };
      } else { response.end(JSON.stringify({ jsonrpc: '2.0', id: data.id, error: { code: -32601, message: 'Method not available.' } })); return; }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: data.id, result }));
    };
    void handle().catch(() => { if (!response.writableEnded) response.writeHead(400).end(JSON.stringify({ error: 'Invalid or interrupted tool request.' })); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Unable to start read tools.'); }
  return { url: `http://127.0.0.1:${address.port}/mcp`, token, close: () => { server.closeAllConnections(); server.close(); } };
}
