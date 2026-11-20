export interface LoadJob {
  id: string;
  run(signal: AbortSignal): Promise<void>;
  timedOut?(): void;
}

/** Background navigations are serial, cancellable and spaced; foreground opens never wait here. */
export class LoadQueue {
  private jobs = new Map<string, LoadJob>();
  private active: { id: string; controller: AbortController } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  constructor(private readonly gapMs = 1_000, private readonly timeoutMs = 20_000) {}
  add(job: LoadJob): void {
    if (this.disposed || this.active?.id === job.id && !this.active.controller.signal.aborted) return;
    this.jobs.set(job.id, job);
    this.schedule();
  }
  cancel(id: string, abortActive = true): void {
    this.jobs.delete(id);
    if (abortActive && this.active?.id === id) this.active.controller.abort();
  }
  clear(): void {
    this.jobs.clear(); this.active?.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  dispose(): void { this.disposed = true; this.clear(); }
  private schedule(): void {
    if (this.timer || this.active || this.disposed || !this.jobs.size) return;
    this.timer = setTimeout(() => { this.timer = null; void this.next(); }, this.gapMs);
  }
  private async next(): Promise<void> {
    const job = this.jobs.values().next().value;
    if (!job || this.disposed) return;
    this.jobs.delete(job.id);
    const controller = new AbortController();
    this.active = { id: job.id, controller };
    const timeout = setTimeout(() => { controller.abort(); job.timedOut?.(); }, this.timeoutMs);
    try { await job.run(controller.signal); }
    catch (err) { if (!controller.signal.aborted) console.warn('[load-queue]', err); }
    finally { clearTimeout(timeout); this.active = null; this.schedule(); }
  }
}
