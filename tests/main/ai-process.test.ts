import { describe, it, expect } from 'vitest';
import { JsonRpcProcess, runtimeEnvironment } from '@main/ai/process';
import { codexArguments } from '@main/ai/codex';
import { claudeArguments } from '@main/ai/claude';

// A tiny child protocol peer exercises the actual transport and teardown, without provider auth.
const peer = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk; let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); const m = JSON.parse(line);
    if (m.method === 'hello') process.stdout.write(JSON.stringify({ id: m.id, result: 'ready' }) + '\\n');
    if (m.method === 'action') { globalThis.waiting = m.id; process.stdout.write(JSON.stringify({ id: 'action-id', method: 'shell/exec', params: { command: 'forbidden' } }) + '\\n'); }
    if (m.id === 'action-id') process.stdout.write(JSON.stringify({ id: globalThis.waiting, result: m.error }) + '\\n');
    if (m.method === 'oversized') process.stdout.write('x'.repeat(2000001));
    if (m.method === 'die') process.exit(1);
  }
});`;
const runtime = () => new JsonRpcProcess(process.execPath, ['-e', peer], runtimeEnvironment(), process.cwd());

describe('provider process isolation', () => {
  it('passes only allowed environment keys and uses no shell or API-key inheritance', () => {
    expect(Object.keys(runtimeEnvironment()).every((k) => ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot'].includes(k))).toBe(true);
    const codex = codexArguments().join(' '), claude = claudeArguments({ url: 'http://127.0.0.1:1/mcp', token: 'fixture' }, 'Test instructions');
    expect(codex).toContain('features.shell_tool=false');
    expect(codex).toContain('features.multi_agent=false');
    expect(codex).toContain('features.skip_host_skill_discovery=true');
    expect(claude[claude.indexOf('--tools') + 1]).toBe('');
    expect(claude).toContain('--restricted'); expect(claude).toContain('--strict-mcp-config');
    expect(claude).not.toContain('--bare'); // --bare disables the subscription auth path.
  });
  it('denies unexpected runtime requests and terminates outstanding requests on exit', async () => {
    const rpc = runtime();
    try {
      expect(await rpc.request('hello')).toBe('ready');
      expect(await rpc.request('action')).toMatchObject({ code: -32601, message: 'This action is not available in Hangar search.' });
      await expect(rpc.request('die')).rejects.toThrow('stopped');
    } finally { rpc.dispose(); }
  });
  it('rejects oversized provider output and cancels startup/in-flight transport work', async () => {
    const rpc = runtime();
    await expect(rpc.request('oversized')).rejects.toThrow('stopped');
    const second = runtime();
    const pending = second.request('never-answers');
    second.dispose();
    await expect(pending).rejects.toThrow('stopped');
    await expect(second.request('hello')).rejects.toThrow('stopped');
  });
});
