import path from 'node:path';
import fs from 'node:fs';
import { array, object, string } from '@core/inbox/policy';
import type { EngineStatus } from '@shared/ai';
import { AgentError, type AgentEngine, type AgentEvent, type EngineRequest, type ToolBroker } from './contracts';
import { executable, JsonRpcProcess, runtimeDirectory, runtimeEnvironment, smallCommand } from './process';

/** Verified against the installed protocol and a local mock Responses endpoint; see runtime tests.
 * Fail closed on upgrades until their tool surface has been checked. No user profile is imported. */
export const CODEX_VERSION = '0.163.0';
export const CODEX_DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'shell_snapshot', 'code_mode', 'code_mode_host',
  'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'multi_agent', 'hooks',
  'memories', 'goals', 'search_tool', 'tool_search', 'tool_suggest', 'js_repl', 'image_generation', 'request_permissions'];
export function codexArguments(): string[] {
  return ['app-server', '--stdio', ...CODEX_DISABLED_FEATURES.flatMap((flag) => ['-c', `features.${flag}=false`]),
    '-c', 'features.skip_host_skill_discovery=true', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
    '-c', 'tools.experimental_request_user_input.enabled=false', '-c', 'tools.update_plan.enabled=false',
    '-c', 'analytics.enabled=false', '-c', 'mcp_servers={}', '-c', 'cli_auth_credentials_store="keyring"'];
}
export class CodexEngine implements AgentEngine {
  readonly id = 'codex' as const;
  private rpc: JsonRpcProcess | null = null;
  private starting: Promise<JsonRpcProcess> | null = null;
  private generation = 0;
  private initializing: JsonRpcProcess | null = null;
  private loginId: string | null = null;
  private readonly directory: string;
  private readonly work: string;
  constructor(root: string, private readonly openUrl: (url: string) => Promise<void>, private readonly changed: () => void) {
    this.directory = runtimeDirectory(root, 'codex');
    this.work = path.join(this.directory, 'workspace'); fs.mkdirSync(this.work, { recursive: true, mode: 0o700 });
  }
  private env(): NodeJS.ProcessEnv { return { ...runtimeEnvironment(), CODEX_HOME: this.directory }; }
  private async ensure(): Promise<JsonRpcProcess> {
    if (this.rpc) return this.rpc;
    if (this.starting) return this.starting;
    const generation = this.generation;
    const starting = (async () => {
      const file = executable('codex');
      if (!file) throw new AgentError('Install Codex CLI to use this provider.');
      const version = await smallCommand(file, ['--version'], this.env(), this.work);
      if (!version.trim().endsWith(` ${CODEX_VERSION}`)) throw new AgentError(`This integration supports Codex CLI ${CODEX_VERSION}. This installed version needs a compatibility check.`);
      if (generation !== this.generation) throw new AgentError('Runtime operation cancelled.');
      const rpc = new JsonRpcProcess(file, codexArguments(), this.env(), this.work);
      this.initializing = rpc;
      rpc.onNotification = (method) => { if (method.startsWith('account/')) { this.loginId = null; this.changed(); } };
      rpc.onExit = () => { if (this.rpc === rpc) this.rpc = null; this.changed(); };
      try {
        await rpc.request('initialize', { clientInfo: { name: 'hangar', title: 'Hangar', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        rpc.notify('initialized');
        const config = object(object(await rpc.request('config/read', { includeLayers: false })).config);
        const features = object(config.features);
        // The isolated profile can still have managed policy. Refuse a conflicting effective policy.
        if (CODEX_DISABLED_FEATURES.some((flag) => features[flag] === true) || config.web_search !== 'disabled'
          || Object.keys(object(config.mcp_servers)).length > 0) throw new AgentError('The Codex policy does not allow Hangar’s restricted search profile.');
        if (generation !== this.generation) throw new AgentError('Runtime operation cancelled.');
        this.initializing = null;
        this.rpc = rpc;
        return rpc;
      } catch (e) { rpc.dispose(); throw e; }
    })().finally(() => { if (this.starting === starting) this.starting = null; });
    this.starting = starting;
    return starting;
  }
  async status(): Promise<EngineStatus> {
    if (!executable('codex')) return { id: this.id, name: 'Codex', state: 'missing', detail: 'Install Codex CLI to connect your ChatGPT account.' };
    try {
      const rpc = await this.ensure(), account = object(object(await rpc.request('account/read', { refreshToken: false })).account);
      return { id: this.id, name: 'Codex', version: CODEX_VERSION, state: account.type ? 'ready' : 'sign-in',
        detail: account.type ? `Signed in${account.email ? ` as ${string(account.email, 320)}` : ''}. Uses your Codex account’s limits.` : this.loginId ? 'Finish signing in in your browser.' : 'Sign in with ChatGPT. This profile is separate from your coding sessions.' };
    } catch (e) { return { id: this.id, name: 'Codex', state: 'unsupported', detail: e instanceof AgentError ? e.message : 'Unable to start the Codex runtime.' }; }
  }
  async login(): Promise<void> {
    const rpc = await this.ensure();
    if (this.loginId) await rpc.request('account/login/cancel', { loginId: this.loginId });
    const result = object(await rpc.request('account/login/start', { type: 'chatgpt' }));
    const url = new URL(string(result.authUrl));
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) throw new AgentError('The runtime returned an unexpected sign-in address.');
    this.loginId = string(result.loginId);
    await this.openUrl(url.href);
  }
  async logout(): Promise<void> { const rpc = await this.ensure(); await rpc.request('account/logout'); this.loginId = null; }
  async run(request: EngineRequest, broker: ToolBroker, emit: (event: AgentEvent) => void): Promise<void> {
    const rpc = await this.ensure();
    request.signal.throwIfAborted();
    const account = object(object(await rpc.request('account/read', { refreshToken: false })).account);
    if (!account.type) throw new AgentError('Sign in to Codex before searching.');
    const result = object(await rpc.request('thread/start', { cwd: this.work, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', environments: [],
      baseInstructions: request.instructions, dynamicTools: broker.tools.map((tool) => ({ type: 'function', ...tool })) }));
    const threadId = string(object(result.thread).id);
    if (!threadId || object(result.sandbox).type !== 'readOnly' || object(result.sandbox).networkAccess !== false || array(result.instructionSources).length) {
      this.dispose(); throw new AgentError('The runtime did not establish a restricted search session.');
    }
    let finish: () => void = () => {}, fail: (e: Error) => void = () => {};
    const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    void completed.catch(() => {});
    let turnId = '';
    const oldNotify = rpc.onNotification, oldExit = rpc.onExit;
    const cancel = () => { if (turnId) void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {}); this.dispose(); fail(new AgentError('Search cancelled.')); };
    rpc.onExit = () => { oldExit(); fail(new AgentError('Codex stopped before finishing this search.')); };
    rpc.onRequest = async (method, params) => {
      const p = object(params);
      if (method !== 'item/tool/call' || p.threadId !== threadId || request.signal.aborted) throw new AgentError('Runtime action denied.');
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(await broker.call(string(p.tool, 100), p.arguments)) }] };
    };
    rpc.onNotification = (method, params) => {
      oldNotify(method, params);
      const p = object(params);
      if (p.threadId !== threadId) return;
      if (method === 'turn/started') turnId = string(object(p.turn).id);
      if (method === 'item/agentMessage/delta') emit({ type: 'text', delta: string(p.delta) });
      if (method === 'turn/completed') {
        const turn = object(p.turn);
        if (turn.status === 'completed') finish(); else fail(new AgentError('Codex could not finish this search. Check account limits and retry.'));
      }
      if (method === 'error' && p.willRetry !== true) fail(new AgentError('Codex reported a search error. Check account access and usage limits.'));
    };
    request.signal.addEventListener('abort', cancel, { once: true });
    try {
      request.signal.throwIfAborted();
      const started = object(await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: request.prompt, text_elements: [] }] }));
      turnId ||= string(object(started.turn).id);
      await completed;
    } finally {
      request.signal.removeEventListener('abort', cancel);
      rpc.onNotification = oldNotify; rpc.onExit = oldExit;
      rpc.onRequest = async () => { throw new AgentError('No search is active.'); };
      if (this.rpc === rpc) { try { await rpc.request('thread/unsubscribe', { threadId }); } catch { this.dispose(); } }
    }
  }
  dispose(): void {
    this.generation++;
    const rpc = this.rpc, initializing = this.initializing;
    this.rpc = null; this.initializing = null; this.starting = null;
    rpc?.dispose(); initializing?.dispose();
  }
}
