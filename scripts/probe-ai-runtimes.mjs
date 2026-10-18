// Opt-in compatibility check. Installed, unmodified CLIs talk to synthetic loopback inference
// endpoints, with fresh profiles and no real credentials. No paid requests or private content.
// Run: node scripts/probe-ai-runtimes.mjs [codex|claude]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-runtime-probe-'));
const bundle = path.join(directory, 'runtime.cjs');
await build({ stdin: { contents: `export { codexArguments, CODEX_VERSION } from './src/main/ai/codex';
export { claudeArguments, CLAUDE_VERSION } from './src/main/ai/claude';
export { startMcp } from './src/main/ai/mcp';
export { executable, runtimeEnvironment, smallCommand, stopProcess, JsonRpcProcess } from './src/main/ai/process';
export { SEARCH_TOOLS } from './src/core/ai/policy';`, resolveDir: root },
bundle: true, platform: 'node', format: 'cjs', outfile: bundle, alias: { '@core': path.join(root, 'src/core') } });
const { codexArguments, CODEX_VERSION, claudeArguments, CLAUDE_VERSION, startMcp, executable, runtimeEnvironment, smallCommand, stopProcess, JsonRpcProcess, SEARCH_TOOLS } = createRequire(import.meta.url)(bundle);
const names = ['hangar_read', 'hangar_search'];
const listen = (server) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); });
const close = (server) => { server.closeAllConnections(); server.close(); };
const send = (response, type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const fixture = { results: [{ id: 'S1', title: 'Synthetic feature', preview: 'Beta is Monday.' }] };

async function codexProbe() {
  const home = path.join(directory, 'codex'); fs.mkdirSync(home);
  const file = executable('codex'); assert(file, 'Codex CLI is not installed');
  const env = { ...runtimeEnvironment(), CODEX_HOME: home };
  assert((await smallCommand(file, ['--version'], env, home)).trim().endsWith(` ${CODEX_VERSION}`));
  let requests = 0, calls = 0, answer = '', protocolError;
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      assert.deepEqual(body.tools.map((t) => t.name).sort(), names);
      const tool = ++requests === 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const item = tool ? { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'hangar_search', arguments: JSON.stringify({ connectionId: 'fixture', query: 'feature' }) }
        : { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Beta is Monday. [S1]', annotations: [] }] };
      send(res, 'response.created', { response: { id: `r${requests}`, status: 'in_progress', output: [] } });
      send(res, 'response.output_item.added', { output_index: 0, item: tool ? { ...item, arguments: '' } : { ...item, content: [] } });
      if (!tool) {
        send(res, 'response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        send(res, 'response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'Beta is Monday. [S1]' });
      }
      send(res, 'response.output_item.done', { output_index: 0, item });
      send(res, 'response.completed', { response: { id: `r${requests}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
      res.end();
    } catch (e) { protocolError = e; res.writeHead(500).end(); }
  });
  const url = await listen(server);
  const rpc = new JsonRpcProcess(file, [...codexArguments(), '-c', 'model_provider="mock"', '-c', 'model="gpt-6"',
    '-c', `model_providers.mock={name="Local fixture",base_url="${url}/v1",wire_api="responses",requires_openai_auth=false}`,
    '-c', 'cli_auth_credentials_store="file"', '-c', 'features.enable_request_compression=false'], env, home);
  let timer;
  try {
    await rpc.request('initialize', { clientInfo: { name: 'hangar_probe', version: '0.1.0' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
    const config = await rpc.request('config/read', { includeLayers: false }); assert.equal(config.config.web_search, 'disabled');
    const result = await rpc.request('thread/start', { ephemeral: true, cwd: home, approvalPolicy: 'never', sandbox: 'read-only', environments: [], baseInstructions: 'Use the supplied search tool.', dynamicTools: SEARCH_TOOLS.map((t) => ({ type: 'function', ...t })) });
    assert.equal(result.sandbox.type, 'readOnly'); assert.equal(result.sandbox.networkAccess, false); assert.equal(result.instructionSources.length, 0);
    rpc.onRequest = async (method, p) => {
      assert.equal(method, 'item/tool/call'); assert.equal(p.threadId, result.thread.id); assert.equal(p.tool, 'hangar_search');
      assert.deepEqual(p.arguments, { connectionId: 'fixture', query: 'feature' }); calls++;
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(fixture) }] };
    };
    const finished = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Codex protocol probe timed out')), 20000);
      rpc.onNotification = (method, p) => {
        if (method === 'item/agentMessage/delta') answer += p.delta;
        if (method === 'turn/completed') p.turn.status === 'completed' ? resolve() : reject(new Error('Turn failed'));
      };
    });
    await rpc.request('turn/start', { threadId: result.thread.id, input: [{ type: 'text', text: 'Find the synthetic feature.', text_elements: [] }] });
    await finished;
    if (protocolError) throw protocolError;
    assert.equal(calls, 1); assert.equal(requests, 2); assert.equal(answer, 'Beta is Monday. [S1]');
    console.log(`Codex ${CODEX_VERSION}: restricted manifest, host tool call, streamed answer and completion passed.`);
  } finally { clearTimeout(timer); rpc.dispose(); close(server); }
}

async function claudeProbe() {
  const home = path.join(directory, 'claude'); fs.mkdirSync(home);
  const file = executable('claude'); assert(file, 'Claude Code is not installed');
  const baseEnv = { ...runtimeEnvironment(), CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  assert((await smallCommand(file, ['--version'], baseEnv, home)).startsWith(`${CLAUDE_VERSION} `));
  let calls = 0, requests = 0, initialized = false, answer = '', completed = false, failure;
  const mcp = await startMcp({ tools: SEARCH_TOOLS, call: async (name, args) => {
    assert.equal(name, 'hangar_search'); assert.deepEqual(args, { connectionId: 'fixture', query: 'feature' }); calls++; return fixture;
  } });
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part;
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"input_tokens":10}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404).end(); return; }
      const body = JSON.parse(raw); assert.deepEqual(body.tools.map((t) => t.name).sort(), names.map((n) => `mcp__hangar__${n}`));
      const tool = ++requests === 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      send(res, 'message_start', { message: { id: 'fixture', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      send(res, 'content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: 'call_1', name: 'mcp__hangar__hangar_search', input: {} } : { type: 'text', text: '' } });
      send(res, 'content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ connectionId: 'fixture', query: 'feature' }) } : { type: 'text_delta', text: 'Beta is Monday. [S1]' } });
      send(res, 'content_block_stop', { index: 0 });
      send(res, 'message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
      send(res, 'message_stop', {}); res.end();
    } catch (e) { failure = e; res.writeHead(500).end(); }
  });
  const url = await listen(server);
  const child = spawn(file, claudeArguments(mcp, 'Use the supplied search tool.'), { cwd: home, env: { ...baseEnv, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'synthetic-local-only' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { failure = new Error('Claude protocol probe timed out'); stopProcess(child); }, 20000);
  try {
    let buffer = ''; child.stderr.resume(); child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      buffer += data; let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const m = JSON.parse(raw);
          if (m.type === 'system' && m.subtype === 'init') { assert.deepEqual(m.tools.sort(), names.map((n) => `mcp__hangar__${n}`)); initialized = true; }
          if (m.type === 'stream_event' && m.event.delta?.type === 'text_delta') answer += m.event.delta.text;
          if (m.type === 'result') { assert.equal(m.subtype, 'success'); assert.equal(m.is_error, false); completed = true; }
        } catch (e) { failure = e; stopProcess(child); }
      }
    });
    child.stdin.end('Find the synthetic feature.');
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (failure) throw failure;
    assert.equal(code, 0); assert(initialized && completed); assert.equal(calls, 1); assert.equal(requests, 2); assert.equal(answer, 'Beta is Monday. [S1]');
    console.log(`Claude Code ${CLAUDE_VERSION}: restricted manifest, authenticated MCP call, streamed answer and completion passed.`);
  } finally { clearTimeout(timer); stopProcess(child); mcp.close(); close(server); }
}

try {
  const provider = process.argv[2]; assert(!provider || ['codex', 'claude'].includes(provider), 'Expected codex or claude');
  if (!provider || provider === 'codex') await codexProbe();
  if (!provider || provider === 'claude') await claudeProbe();
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
