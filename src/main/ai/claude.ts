import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { array, object, string } from '@core/inbox/policy';
import type { EngineStatus } from '@shared/ai';
import { AgentError, type AgentEngine, type AgentEvent, type EngineRequest, type ToolBroker } from './contracts';
import { executable, runtimeDirectory, runtimeEnvironment, smallCommand, stopProcess } from './process';
import { startMcp } from './mcp';

export const CLAUDE_VERSION = '2.1.292';
export type ClaudeLogin = 'subscription' | 'console' | 'sso';
export function claudeArguments(mcp: { url: string; token: string }, instructions: string): string[] {
  return ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages',
    '--restricted', '--tools', '', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config',
    '--settings', JSON.stringify({ disableAllHooks: true, enabledPlugins: {} }),
    '--mcp-config', JSON.stringify({ mcpServers: { hangar: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }),
    '--allowedTools', 'mcp__hangar__hangar_search,mcp__hangar__hangar_read', '--system-prompt', instructions];
}
export class ClaudeEngine implements AgentEngine {
  readonly id = 'claude' as const;
  private readonly directory: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private signingIn = false;
  constructor(root: string, private readonly changed: () => void) { this.directory = runtimeDirectory(root, 'claude'); }
  private env(): NodeJS.ProcessEnv { return { ...runtimeEnvironment(), CLAUDE_CONFIG_DIR: this.directory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }; }
  private async file(): Promise<string> {
    const file = executable('claude');
    if (!file) throw new AgentError('Install Claude Code to use this provider.');
    const version = await smallCommand(file, ['--version'], this.env(), this.directory);
    if (!version.startsWith(`${CLAUDE_VERSION} `)) throw new AgentError(`This integration supports Claude Code ${CLAUDE_VERSION}. This installed version needs a compatibility check.`);
    return file;
  }
  async status(): Promise<EngineStatus> {
    if (!executable('claude')) return { id: this.id, name: 'Claude Code', state: 'missing', detail: 'Install the unmodified Claude Code CLI to connect.' };
    try {
      const file = await this.file();
      let status: Record<string, unknown> = {};
      try { status = object(JSON.parse(await smallCommand(file, ['auth', 'status', '--json'], this.env(), this.directory))); } catch { /* CLI exits 1 while signed out. */ }
      return { id: this.id, name: 'Claude Code', version: CLAUDE_VERSION, state: status.loggedIn === true ? 'ready' : 'sign-in',
        detail: status.loggedIn === true ? `Signed in using ${string(status.authMethod, 60) || 'Claude Code'}. Your provider’s billing and limits apply.`
          : this.signingIn ? 'Complete Claude Code’s sign-in in your browser.' : 'Sign in through the unmodified Claude Code CLI. Subscription, Console and SSO choices are available.' };
    } catch (e) { return { id: this.id, name: 'Claude Code', state: 'unsupported', detail: e instanceof AgentError ? e.message : 'Unable to start Claude Code.' }; }
  }
  async login(mode: ClaudeLogin = 'subscription'): Promise<void> {
    if (this.child) throw new AgentError('Finish or cancel the active Claude Code operation first.');
    const file = await this.file();
    this.signingIn = true; this.changed();
    try { await this.process(file, ['auth', 'login', ...(mode === 'console' ? ['--console'] : mode === 'sso' ? ['--sso'] : [])], undefined, () => {}); }
    finally { this.signingIn = false; this.changed(); }
  }
  async logout(): Promise<void> { this.dispose(); await smallCommand(await this.file(), ['auth', 'logout'], this.env(), this.directory); }
  private process(file: string, args: string[], input: string | undefined, line: (data: Record<string, unknown>) => void, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd: this.directory, env: this.env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      let buffer = '', failed = false;
      const stop = () => { failed = true; stopProcess(child); reject(new AgentError('Claude Code operation cancelled.')); };
      signal?.addEventListener('abort', stop, { once: true });
      const timeout = setTimeout(stop, input === undefined ? 180_000 : 210_000);
      child.stdout.setEncoding('utf8'); child.stderr.resume();
      child.stdout.on('data', (chunk: string) => {
        // Login output is managed by the CLI; it opens its own browser. Never relay auth URLs/codes.
        if (input === undefined || failed) return;
        buffer += chunk;
        if (buffer.length > 2_000_000) { stop(); return; }
        let at: number;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          if (!raw.trim()) continue;
          try { line(object(JSON.parse(raw))); } catch { stop(); return; }
        }
      });
      child.stdin.on('error', () => {});
      child.once('error', () => { failed = true; reject(new AgentError('Could not start Claude Code.')); });
      child.once('close', (code) => {
        clearTimeout(timeout); signal?.removeEventListener('abort', stop);
        if (this.child === child) this.child = null;
        if (!failed) { if (code === 0) resolve(); else reject(new AgentError('Claude Code could not finish. Check its login, account access and usage limits.')); }
      });
      if (signal?.aborted) stop();
      if (input !== undefined) child.stdin.end(input);
    });
  }
  async run(request: EngineRequest, broker: ToolBroker, emit: (event: AgentEvent) => void): Promise<void> {
    if (this.child) throw new AgentError('Claude Code is already busy.');
    const file = await this.file(); request.signal.throwIfAborted();
    const mcp = await startMcp(broker);
    let receivedResult = false, hasDeltas = false;
    try {
      await this.process(file, claudeArguments(mcp, request.instructions), request.prompt, (data) => {
        if (data.type === 'system' && data.subtype === 'init') {
          const allowed = new Set(['mcp__hangar__hangar_search', 'mcp__hangar__hangar_read']);
          if (array(data.tools).some((tool) => typeof tool !== 'string' || !allowed.has(tool))) throw new AgentError('Claude Code exposed unexpected tools.');
        }
        if (data.type === 'stream_event') {
          const event = object(data.event), delta = object(event.delta);
          if (event.type === 'content_block_delta' && delta.type === 'text_delta') { hasDeltas = true; emit({ type: 'text', delta: string(delta.text) }); }
        }
        if (data.type === 'result') {
          if (data.is_error === true || data.subtype !== 'success') throw new AgentError('Claude Code returned an incomplete result.');
          receivedResult = true;
          if (!hasDeltas) emit({ type: 'text', delta: string(data.result, 50_000) });
        }
      }, request.signal);
      if (!receivedResult) throw new AgentError('Claude Code returned no completed answer.');
    } finally { mcp.close(); }
  }
  dispose(): void { if (this.child) stopProcess(this.child); this.child = null; }
}
