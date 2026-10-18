import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AgentError } from './contracts';
import { object } from '@core/inbox/policy';

export function executable(name: 'codex' | 'claude'): string | null {
  const directories = [...(process.env['PATH'] ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];
  for (const directory of directories.filter((d) => path.isAbsolute(d))) {
    const file = path.join(directory, name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* Next standard installation location. */ }
  }
  return null;
}
/** No shell, inherited NODE_OPTIONS, unrelated API keys, plugin paths or developer tracing. */
export function runtimeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
export function runtimeDirectory(root: string, provider: string): string {
  const directory = path.join(root, 'ai-runtimes', provider);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
export function smallCommand(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { env, cwd, timeout: 10_000, maxBuffer: 64_000 }, (error, stdout) => {
    if (error) reject(new AgentError('The local runtime could not complete this request. Check its installation and login.'));
    else resolve(stdout);
  }));
}
export function stopProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1500);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

/** Bounded newline JSON transport. Provider stderr is deliberately never forwarded to app logs. */
export class JsonRpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = '';
  private stopped = false;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onNotification: (method: string, params: unknown) => void = () => {};
  onRequest: (method: string, params: unknown) => Promise<unknown> = async () => { throw new AgentError('Runtime action denied.'); };
  onExit: () => void = () => {};
  constructor(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
    this.child = spawn(file, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 2_000_000) { this.dispose(); return; }
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { this.receive(object(JSON.parse(line))); } catch { this.dispose(); return; }
      }
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.dispose());
    this.child.once('error', () => this.dispose());
    this.child.once('exit', () => this.dispose());
  }
  private receive(message: Record<string, unknown>): void {
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        void this.onRequest(message.method, message.params).then(
          (result) => this.write({ id: message.id, result }),
          () => this.write({ id: message.id, error: { code: -32601, message: 'This action is not available in Hangar search.' } }),
        );
      } else this.onNotification(message.method, message.params);
    } else if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new AgentError('The runtime rejected this request. Check its version, account access and usage limits.'));
      else pending.resolve(message.result);
    }
  }
  private write(value: unknown): void {
    if (!this.stopped && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  notify(method: string, params?: unknown): void { this.write({ method, params }); }
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.stopped) return Promise.reject(new AgentError('The runtime stopped. Check its installation and retry.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AgentError('The runtime did not respond in time.')); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AgentError('The runtime stopped.')); }
    this.pending.clear(); stopProcess(this.child); this.onExit();
  }
}
