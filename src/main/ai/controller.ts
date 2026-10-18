import { randomUUID } from 'node:crypto';
import { engineId, SEARCH_INSTRUCTIONS, validStart } from '@core/ai/policy';
import { itemId, object, string } from '@core/inbox/policy';
import type { AiRun, AiSnapshot, AiStart, EngineId, EngineStatus } from '@shared/ai';
import type { InboxReply, SourceRef } from '@shared/inbox';
import type { ConnectorHub } from '@main/connectors/hub';
import { AgentError, type AgentEngine, type AgentEvent } from './contracts';
import { CodexEngine } from './codex';
import { ClaudeEngine, type ClaudeLogin } from './claude';
import { SearchBroker } from './broker';

export class AiController {
  private readonly engines: Record<EngineId, AgentEngine>;
  private providers: EngineStatus[] = [
    { id: 'codex', name: 'Codex', state: 'unchecked', detail: 'Check the installed runtime, then sign in.' },
    { id: 'claude', name: 'Claude Code', state: 'unchecked', detail: 'Uses the unmodified local Claude Code runtime.' },
  ];
  private run: AiRun | null = null;
  private active: AbortController | null = null;
  private allowed = new Set<string>();
  private allWorkspaces = false;
  private context: AiSnapshot['context'] = null;
  private workspaceId: string | null | undefined;
  private probing = new Set<EngineId>();
  private disposed = false;
  constructor(private readonly hub: ConnectorHub, root: string, openUrl: (url: string) => Promise<void>, private readonly changed: () => void,
    engines?: Record<EngineId, AgentEngine>) {
    this.engines = engines ?? { codex: new CodexEngine(root, openUrl, () => this.changed()), claude: new ClaudeEngine(root, () => this.changed()) };
  }
  snapshot(): AiSnapshot {
    const inbox = this.hub.snapshot({ allWorkspaces: this.allWorkspaces });
    return { providers: this.providers, sources: inbox.sources, workspaceId: inbox.workspaceId, workspaceName: inbox.workspaceName,
      allWorkspaces: this.allWorkspaces, context: this.context, run: this.run };
  }
  setContext(ref?: SourceRef): void {
    this.context = null;
    if (ref) {
      const snapshot = this.hub.snapshot({ allWorkspaces: this.allWorkspaces });
      const item = snapshot.items.find((i) => i.id === itemId(ref));
      if (item && snapshot.sources.some((s) => s.id === ref.connectionId && s.canRead)) this.context = { ref, title: item.title };
    }
    this.changed();
  }
  sourceChanged(): void {
    if (this.disposed || (!this.run && !this.context)) return;
    try {
      const snapshot = this.snapshot();
      if (this.workspaceId !== undefined && snapshot.workspaceId !== this.workspaceId) { this.clear(); this.context = null; return; }
      const ids = new Set(snapshot.sources.filter((s) => s.canSearch).map((s) => s.id));
      if ([...this.allowed].some((id) => !ids.has(id))) this.clear();
      if (this.context && !ids.has(this.context.ref.connectionId)) this.context = null;
      this.changed();
    } catch { this.clear(); this.context = null; }
  }
  async probe(provider: EngineId): Promise<void> {
    if (this.probing.has(provider)) return;
    this.probing.add(provider);
    try {
      const status = await this.engines[provider].status();
      if (!this.disposed) { this.providers = this.providers.map((p) => p.id === provider ? status : p); this.changed(); }
    } finally { this.probing.delete(provider); }
  }
  private start(input: AiStart): void {
    if (this.active) throw new AgentError('Cancel the current search before starting another.');
    if (input.allWorkspaces !== this.allWorkspaces) throw new AgentError('The search scope changed. Review the accounts and try again.');
    const snapshot = this.snapshot();
    const allowed = new Set(input.sourceIds);
    const sources = snapshot.sources.filter((s) => allowed.has(s.id) && s.canSearch);
    if (!sources.length || sources.length !== allowed.size) throw new AgentError('One of the selected accounts is no longer available for search.');
    if (input.includeContext && this.context && !allowed.has(this.context.ref.connectionId)) throw new AgentError('Select the context account or turn off Include selected thread.');
    const previous = this.run?.state === 'complete' && this.run.provider === input.provider
      && allowed.size === this.allowed.size && [...allowed].every((id) => this.allowed.has(id)) ? this.run : null;
    this.allowed = allowed; this.workspaceId = snapshot.workspaceId;
    const controller = new AbortController(); this.active = controller;
    const run: AiRun = { id: randomUUID(), provider: input.provider, query: input.query.trim(), state: 'running', answer: '', evidence: [],
      progress: ['Preparing a bounded search of the selected accounts…'], error: null };
    this.run = run; this.changed();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180_000);
    const emit = (event: AgentEvent) => {
      if (this.run !== run || controller.signal.aborted || this.disposed) return;
      if (event.type === 'text') {
        run.answer = (run.answer + event.delta).slice(0, 50_000);
        if (run.answer.length >= 50_000) { run.error = 'Answer limit reached. Narrow your next question.'; controller.abort(); }
      } else if (event.type === 'status') {
        if (run.progress.at(-1) !== event.text) run.progress = [...run.progress, event.text].slice(-20);
      } else {
        const index = run.evidence.findIndex((e) => e.id === event.evidence.id);
        if (index < 0) run.evidence.push(event.evidence); else run.evidence[index] = event.evidence;
      }
      this.changed();
    };
    const broker = new SearchBroker(this.hub, sources, controller.signal, emit);
    const context = input.includeContext ? this.context : null;
    const perform = async () => {
      const contextData = context ? await broker.context(context.ref, context.title) : null;
      const prompt = JSON.stringify({ question: run.query, authorizedAccounts: sources.map((s) => ({ connectionId: s.id, app: s.app, identity: s.identity ?? s.label })),
        selectedThread: contextData, previousQuestion: previous?.query ?? null, previousAnswerForContextOnly: previous?.answer.slice(0, 6000) ?? null,
        note: 'Re-verify previous claims with current tools; only this run’s source IDs are valid. Other apps may be connected as browser panes but are unavailable for history search.' });
      await this.engines[input.provider].run({ prompt, instructions: SEARCH_INSTRUCTIONS, signal: controller.signal }, broker, emit);
    };
    void perform().then(() => {
      if (this.run === run && controller.signal.aborted) { run.state = 'cancelled'; run.error ??= 'Search stopped. Partial results may be incomplete.'; }
      if (this.run === run && !controller.signal.aborted) {
        run.state = 'complete';
        if (!run.answer.trim()) run.error = 'The provider returned no answer. Try a more specific question.';
        const citations = [...run.answer.matchAll(/\[S(\d+)\]/g)].map((m) => `S${m[1]}`);
        if (citations.some((id) => !run.evidence.some((e) => e.id === id))) run.error = 'Some source references could not be verified. Only the source buttons below are valid.';
      }
    }, (error: unknown) => {
      if (this.run === run) {
        run.state = controller.signal.aborted ? 'cancelled' : 'error';
        run.error = timedOut ? 'The three-minute search limit was reached. Partial results are shown; narrow your question to continue.'
          : controller.signal.aborted ? run.error ?? 'Search cancelled. Partial results may be incomplete.'
          : error instanceof AgentError ? error.message : 'The search failed. Check source connections and provider access.';
      }
    }).finally(() => {
      clearTimeout(timer);
      if (this.active === controller) this.active = null;
      if (!this.disposed) this.changed();
    });
  }
  cancel(): void { const active = this.active; this.active = null; active?.abort(); for (const engine of Object.values(this.engines)) engine.dispose(); }
  clear(): void { this.cancel(); this.run = null; this.allowed.clear(); this.changed(); }
  async request(action: unknown, payload: unknown): Promise<InboxReply<unknown>> {
    try {
      let value: unknown = null;
      if (action === 'snapshot') value = this.snapshot();
      else if (action === 'scope' && typeof payload === 'boolean') { this.clear(); this.context = null; this.allWorkspaces = payload; this.changed(); }
      else if (action === 'probe' && engineId(payload)) await this.probe(payload);
      else if (action === 'login' && engineId(object(payload).provider)) {
        const provider = object(payload).provider as EngineId, mode = string(object(payload).mode);
        if (mode && !['subscription', 'console', 'sso'].includes(mode)) throw new AgentError('Invalid login choice.');
        if (this.active) throw new AgentError('Cancel the search before signing in.');
        await this.engines[provider].login(mode as ClaudeLogin || undefined); await this.probe(provider);
      } else if (action === 'logout' && engineId(payload)) { this.clear(); await this.engines[payload].logout(); await this.probe(payload); }
      else if (action === 'start' && validStart(payload)) this.start(payload);
      else if (action === 'cancel') this.cancel();
      else if (action === 'clear') this.clear();
      else if (action === 'openCitation' && typeof payload === 'string') {
        const evidence = this.run?.evidence.find((e) => e.id === payload);
        if (!evidence || !this.allowed.has(evidence.ref.connectionId)) throw new AgentError('This source is no longer available.');
        await this.hub.open(evidence.ref);
      } else throw new AgentError('Invalid assistant request.');
      return { ok: true, value };
    } catch (error) { return { ok: false, error: error instanceof AgentError ? error.message : 'Unable to complete this action. Check runtime and account access.' }; }
  }
  dispose(): void { this.disposed = true; this.cancel(); this.run = null; this.context = null; }
}
